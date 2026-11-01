import { access, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { accessSync, constants } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { isInside, type HarnessManifest, type LaunchSpec, type RuntimeResult, type RuntimeStatus } from "./model.js";

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  fix?: string;
}

export interface RuntimeAdapter {
  validate(manifest: HarnessManifest, allManifests: HarnessManifest[], parentEnv: NodeJS.ProcessEnv, projectPath?: string): Promise<Diagnostic[]>;
  prepare(manifest: HarnessManifest, parentEnv: NodeJS.ProcessEnv, projectPath?: string): Promise<LaunchSpec>;
  start(spec: LaunchSpec): Promise<RuntimeResult>;
  stop(signal?: NodeJS.Signals): Promise<void>;
  status(): RuntimeStatus;
}

export function resolveExecutable(command: string, harnessPath: string, env: NodeJS.ProcessEnv): string | undefined {
  const pathLike = path.isAbsolute(command) || command.includes(path.sep) || (path.sep === "/" && command.includes("\\"));
  if (pathLike) {
    const absolute = path.isAbsolute(command) ? command : path.resolve(harnessPath, command);
    return isExecutable(absolute) ? absolute : undefined;
  }

  const extensions = process.platform === "win32"
    ? (env.PATHEXT || ".EXE;.CMD;.BAT").split(";")
    : [""];
  const hasExtension = extensions.some((extension) => extension && command.toLowerCase().endsWith(extension.toLowerCase()));
  for (const directory of (env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const extension of hasExtension ? [""] : extensions) {
      const candidate = path.join(directory, command + extension);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

function isExecutable(filePath: string): boolean {
  try {
    const mode = process.platform === "win32" ? constants.F_OK : constants.X_OK;
    requireAccessSync(filePath, mode);
    return true;
  } catch {
    return false;
  }
}

function requireAccessSync(filePath: string, mode: number): void {
  // Synchronous lookup keeps doctor checks deterministic and does not run the command.
  accessSync(filePath, mode);
}

async function checkConfigDirectory(manifest: HarnessManifest, projectPath: string): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  if (isInside(manifest.workspacePath, manifest.configDirectory) || isInside(projectPath, manifest.configDirectory)) {
    diagnostics.push({ severity: "error", message: "Config directory is inside the Harness or Project folder.", fix: "Set config_directory to a unique path under the manager data directory." });
  }
  let rootExists = false;
  try {
    await stat(manifest.managerHome);
    rootExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      diagnostics.push({ severity: "error", message: `Cannot inspect manager data directory: ${manifest.managerHome}` });
      return diagnostics;
    }
  }
  if (!rootExists) {
    let parent = path.dirname(manifest.managerHome);
    while (parent !== path.dirname(parent)) {
      try {
        const info = await stat(parent);
        if (!info.isDirectory()) diagnostics.push({ severity: "error", message: `Config parent is not a directory: ${parent}` });
        else {
          try { await access(parent, constants.W_OK); }
          catch { diagnostics.push({ severity: "error", message: `Config parent is not writable: ${parent}`, fix: "Choose a writable manager data directory." }); }
        }
        return diagnostics;
      } catch { parent = path.dirname(parent); }
    }
    diagnostics.push({ severity: "error", message: `No writable parent found for manager data directory: ${manifest.managerHome}` });
    return diagnostics;
  }

  try {
    const root = await realpath(manifest.managerHome);
    const relative = path.relative(manifest.managerHome, manifest.configDirectory);
    let cursor = root;
    const parts = relative.split(path.sep).filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      cursor = path.join(cursor, parts[index]!);
      let entry;
      try { entry = await lstat(cursor); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try { await access(path.dirname(cursor), constants.W_OK); }
        catch { diagnostics.push({ severity: "error", message: `Config parent is not writable: ${path.dirname(cursor)}`, fix: "Choose a writable manager-owned config_directory." }); }
        return diagnostics;
      }
      if (entry.isSymbolicLink()) {
        diagnostics.push({ severity: "error", message: `Config path contains a symbolic link: ${cursor}`, fix: "Use a real directory inside the manager data directory." });
        return diagnostics;
      }
      if (!entry.isDirectory()) {
        diagnostics.push({ severity: "error", message: `Config path component is not a directory: ${cursor}` });
        return diagnostics;
      }
      if (index === parts.length - 1) {
        try { await access(cursor, constants.W_OK); }
        catch { diagnostics.push({ severity: "error", message: `Config directory is not writable: ${cursor}`, fix: "Choose a writable manager-owned config_directory." }); }
      }
    }
  } catch {
    diagnostics.push({ severity: "error", message: `Cannot inspect config path: ${manifest.configDirectory}` });
  }
  return diagnostics;
}

async function ensureConfigDirectory(manifest: HarnessManifest): Promise<void> {
  await mkdir(manifest.managerHome, { recursive: true, mode: 0o700 });
  const root = await realpath(manifest.managerHome);
  const relative = path.relative(manifest.managerHome, manifest.configDirectory);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Config directory must be a child of the manager data directory.");
  }
  let cursor = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let entry;
    try {
      entry = await lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try { await mkdir(cursor, { mode: 0o700 }); }
      catch (creationError) {
        if ((creationError as NodeJS.ErrnoException).code !== "EEXIST") throw creationError;
      }
      entry = await lstat(cursor);
    }
    if (entry.isSymbolicLink()) throw new Error(`Config path contains a symbolic link: ${cursor}`);
    if (!entry.isDirectory()) throw new Error(`Config path component is not a directory: ${cursor}`);
  }
}

export class NativeRuntimeAdapter implements RuntimeAdapter {
  private child: ChildProcess | undefined;
  private lastResult: RuntimeResult | undefined;
  private exitPromise: Promise<RuntimeResult> | undefined;

  async validate(manifest: HarnessManifest, allManifests: HarnessManifest[], parentEnv: NodeJS.ProcessEnv, projectPath = manifest.workspacePath): Promise<Diagnostic[]> {
    const diagnostics: Diagnostic[] = [];
    if (manifest.runtimeType !== "native") {
      diagnostics.push({ severity: "error", message: `Runtime '${manifest.runtimeType}' is not implemented.`, fix: "Set runtime_type = \"native\" for the MVP." });
    }
    try {
      if (!(await stat(manifest.workspacePath)).isDirectory()) diagnostics.push({ severity: "error", message: `Harness source is not a directory: ${manifest.workspacePath}` });
    } catch {
      diagnostics.push({ severity: "error", message: `Harness source does not exist: ${manifest.workspacePath}` });
    }
    try {
      const info = await stat(projectPath);
      if (!info.isDirectory()) diagnostics.push({ severity: "error", message: `Project path is not a directory: ${projectPath}` });
    } catch {
      diagnostics.push({ severity: "error", message: `Project path does not exist: ${projectPath}`, fix: "Register an existing Project or choose a valid --workspace path." });
    }
    const command = resolveExecutable(manifest.executable, manifest.workspacePath, parentEnv);
    if (!command) diagnostics.push({ severity: "error", message: `Executable not found or not runnable: ${manifest.executable}`, fix: "Install the CLI locally or set executable to its absolute path." });
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command ?? "")) {
      diagnostics.push({ severity: "error", message: `Windows shell wrapper is not launched: ${command}`, fix: "Use a native executable or set executable to node.exe with the CLI JavaScript file in args." });
    }
    for (const dependency of manifest.dependencies) {
      if (!resolveExecutable(dependency, manifest.workspacePath, parentEnv)) {
        diagnostics.push({ severity: "error", message: `Required dependency not found: ${dependency}`, fix: `Install or expose '${dependency}' on PATH.` });
      }
    }
    for (const other of allManifests) {
      if (other.name !== manifest.name && path.resolve(other.configDirectory) === path.resolve(manifest.configDirectory)) {
        diagnostics.push({ severity: "error", message: `Config directory is shared with Harness '${other.name}'.`, fix: "Assign each Harness its own config_directory." });
      }
    }
    diagnostics.push(...await checkConfigDirectory(manifest, projectPath));
    diagnostics.push({ severity: "info", message: `Config directory: ${manifest.configDirectory}` });
    return diagnostics;
  }

  async prepare(manifest: HarnessManifest, childEnv: NodeJS.ProcessEnv, projectPath = manifest.workspacePath): Promise<LaunchSpec> {
    const diagnostics = await this.validate(manifest, [], childEnv, projectPath);
    const errors = diagnostics.filter((item) => item.severity === "error");
    if (errors.length) throw new Error(errors.map((item) => item.message).join("\n"));
    const command = resolveExecutable(manifest.executable, manifest.workspacePath, childEnv);
    if (!command) throw new Error(`Executable not found: ${manifest.executable}`);
    await ensureConfigDirectory(manifest);
    return {
      command,
      args: [...manifest.args],
      cwd: projectPath,
      env: { ...childEnv },
    };
  }

  start(spec: LaunchSpec): Promise<RuntimeResult> {
    if (this.child) return Promise.reject(new Error("Native runtime is already running."));
    return new Promise<RuntimeResult>((resolve, reject) => {
      const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: "inherit", shell: false, windowsHide: false });
      this.child = child;
      const forwardSignal = (signal: NodeJS.Signals) => { void this.stop(signal); };
      const onInt = () => forwardSignal("SIGINT");
      const onTerm = () => forwardSignal("SIGTERM");
      const onHup = () => forwardSignal("SIGHUP");
      process.on("SIGINT", onInt);
      process.on("SIGTERM", onTerm);
      process.on("SIGHUP", onHup);
      const cleanup = () => {
        process.off("SIGINT", onInt);
        process.off("SIGTERM", onTerm);
        process.off("SIGHUP", onHup);
      };

      this.exitPromise = new Promise<RuntimeResult>((finish) => {
        child.once("close", (code, signal) => {
          cleanup();
          this.child = undefined;
          const result = { code: code ?? signalExitCode(signal), signal };
          this.lastResult = result;
          finish(result);
        });
      });
      child.once("error", (error) => {
        cleanup();
        this.child = undefined;
        reject(error);
      });
      this.exitPromise.then(resolve, reject);
    });
  }

  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const child = this.child;
    if (!child || !this.exitPromise) return;
    try { child.kill(signal); } catch { return; }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.exitPromise.then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          if (this.child === child) child.kill("SIGKILL");
          resolve();
        }, 3000);
        timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  status(): RuntimeStatus {
    if (this.child?.pid) return { state: "running", pid: this.child.pid };
    if (this.lastResult) return { state: "stopped", result: this.lastResult };
    return { state: "idle" };
  }
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  const number = os.constants.signals[signal];
  return 128 + (number ?? 1);
}
