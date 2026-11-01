import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { HarnessManifest } from "./model.js";
import { resolveExecutable, type Diagnostic } from "./runtime.js";

const execFileAsync = promisify(execFile);
const BASE_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR", "PATHEXT"];
const CONFIG_SELECTORS = new Set(["HWM_HOME", "HWM_HARNESS_ROOT", "HWM_PROJECT_ROOT", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]);
const MISE_POLICY_ENV = [
  "MISE_CONFIG_DIR", "MISE_GLOBAL_CONFIG_FILE", "MISE_GLOBAL_CONFIG_ROOT",
  "MISE_SYSTEM_CONFIG_DIR", "MISE_SYSTEM_CONFIG_FILE", "MISE_DATA_DIR",
  "MISE_STATE_DIR", "MISE_INSTALLS_DIR", "MISE_PARANOID",
  "MISE_TRUSTED_CONFIG_PATHS", "MISE_CEILING_PATHS",
];
const MISE_NO_AUTO_INSTALL = ["MISE_AUTO_INSTALL", "MISE_EXEC_AUTO_INSTALL", "MISE_NOT_FOUND_AUTO_INSTALL", "MISE_NOT_FOUND_AUTO_INSTALL_REGISTRY"];

export interface EnvironmentResolution {
  env: NodeJS.ProcessEnv;
  diagnostics: Diagnostic[];
}

export interface EnvironmentProvider {
  resolve(manifest: HarnessManifest, parentEnv: NodeJS.ProcessEnv, projectPath?: string): Promise<EnvironmentResolution>;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key ? env[key] : undefined;
}

function resolveValue(value: string, parentEnv: NodeJS.ProcessEnv, key: string): string {
  const reference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
  if (!reference) return value;
  const resolved = envValue(parentEnv, reference[1]!);
  if (resolved === undefined) throw new Error(`Required environment variable '${reference[1]}' for '${key}' is not set.`);
  return resolved;
}

function baseEnvironment(manifest: HarnessManifest, parentEnv: NodeJS.ProcessEnv): EnvironmentResolution {
  const env: NodeJS.ProcessEnv = {};
  const diagnostics: Diagnostic[] = [];
  for (const name of BASE_ENV) {
    const value = envValue(parentEnv, name);
    if (value !== undefined) env[name] = value;
  }
  for (const name of manifest.environment.inherit) {
    const value = envValue(parentEnv, name);
    if (value === undefined) diagnostics.push({ severity: "error", message: `Required inherited environment variable is not set: ${name}` });
    else env[name] = value;
  }
  for (const [name, value] of Object.entries(manifest.environment.set)) {
    try { env[name] = resolveValue(value, parentEnv, name); }
    catch (error) {
      diagnostics.push({ severity: "error", message: error instanceof Error ? error.message : `Cannot resolve environment variable '${name}'.` });
    }
  }
  for (const key of Object.keys(env)) {
    if (CONFIG_SELECTORS.has(key.toUpperCase()) || key.toUpperCase().startsWith("MISE_")) delete env[key];
  }
  return { env, diagnostics };
}

function withConfigSelector(manifest: HarnessManifest, env: NodeJS.ProcessEnv, projectPath = manifest.workspacePath): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const key of Object.keys(result)) {
    if (CONFIG_SELECTORS.has(key.toUpperCase())) delete result[key];
  }
  result[manifest.configEnv] = manifest.configDirectory;
  result.HWM_HARNESS_ROOT = manifest.workspacePath;
  result.HWM_PROJECT_ROOT = projectPath;
  return result;
}

export class NativeEnvironmentProvider implements EnvironmentProvider {
  async resolve(manifest: HarnessManifest, parentEnv: NodeJS.ProcessEnv, projectPath = manifest.workspacePath): Promise<EnvironmentResolution> {
    const base = baseEnvironment(manifest, parentEnv);
    return { env: withConfigSelector(manifest, base.env, projectPath), diagnostics: base.diagnostics };
  }
}

export class MiseEnvironmentProvider implements EnvironmentProvider {
  constructor(private readonly miseCommand = "mise") {}

  async resolve(manifest: HarnessManifest, parentEnv: NodeJS.ProcessEnv, projectPath = manifest.workspacePath): Promise<EnvironmentResolution> {
    const base = baseEnvironment(manifest, parentEnv);
    const diagnostics = [...base.diagnostics];
    if (diagnostics.some((item) => item.severity === "error")) {
      return { env: withConfigSelector(manifest, base.env, projectPath), diagnostics };
    }
    const configPath = path.join(manifest.workspacePath, "mise.toml");
    try { await access(configPath, constants.R_OK); }
    catch {
      diagnostics.push({ severity: "error", message: `Mise provider requires a readable workspace config: ${configPath}`, fix: "Add mise.toml to this Workspace or set environment.provider = \"native\"." });
      return { env: withConfigSelector(manifest, base.env, projectPath), diagnostics };
    }

    const misePath = resolveExecutable(this.miseCommand, manifest.workspacePath, parentEnv);
    if (!misePath) {
      diagnostics.push({
        severity: "error",
        message: "This Harness requires mise, but the mise executable was not found on PATH.",
        fix: "Install mise separately (for example, `brew install mise` on macOS), then start a new terminal. Harness Workspace Manager does not install it.",
      });
      return { env: withConfigSelector(manifest, base.env, projectPath), diagnostics };
    }

    const miseEnv: NodeJS.ProcessEnv = { ...base.env };
    miseEnv.HWM_HARNESS_ROOT = manifest.workspacePath;
    miseEnv.HWM_PROJECT_ROOT = projectPath;
    for (const name of MISE_POLICY_ENV) {
      const value = envValue(parentEnv, name);
      if (value !== undefined) miseEnv[name] = value;
    }
    const priorCeilings = (miseEnv.MISE_CEILING_PATHS ?? "").split(path.delimiter).filter(Boolean);
    const workspaceCeiling = path.dirname(manifest.workspacePath);
    miseEnv.MISE_CEILING_PATHS = [...new Set([...priorCeilings, workspaceCeiling])].join(path.delimiter);
    for (const name of MISE_NO_AUTO_INSTALL) miseEnv[name] = "0";
    delete miseEnv.MISE_YES;

    let miseVars: Record<string, string>;
    try {
      const output = await runMise(misePath, ["--cd", manifest.workspacePath, "env", "--json"], miseEnv, manifest.workspacePath);
      const parsed: unknown = JSON.parse(output.stdout);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Mise environment output is not a JSON object.");
      miseVars = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value !== "string") throw new Error("Mise environment output contains a non-string value.");
        miseVars[key] = value;
      }
    } catch (error) {
      diagnostics.push(miseDiagnostic(error, configPath));
      return { env: withConfigSelector(manifest, base.env, projectPath), diagnostics };
    }

    const protectedOutput = Object.keys(miseVars).filter((key) =>
      CONFIG_SELECTORS.has(key.toUpperCase()) || key.toUpperCase() === "HOME" || key.toUpperCase().startsWith("MISE_"));
    if (protectedOutput.length) {
      diagnostics.push({
        severity: "error",
        message: `mise.toml exports manager-reserved environment variable(s): ${protectedOutput.join(", ")}.`,
        fix: "Remove manager/runtime selector variables and MISE_* policy variables from the project [env] section.",
      });
      return { env: withConfigSelector(manifest, base.env, projectPath), diagnostics };
    }

    const manifestNames = new Set(Object.keys(manifest.environment.set).map((key) => key.toUpperCase()));
    const conflicts = Object.keys(miseVars).filter((key) => manifestNames.has(key.toUpperCase()) && key.toUpperCase() !== "PATH");
    if (conflicts.length) {
      diagnostics.push({
        severity: "error",
        message: `Environment values are declared in both the Harness manifest and mise.toml: ${[...new Set(conflicts)].join(", ")}.`,
        fix: "Declare each variable in one place only.",
      });
      return { env: withConfigSelector(manifest, base.env, projectPath), diagnostics };
    }

    let missing = "";
    try {
      const result = await runMise(misePath, ["--cd", manifest.workspacePath, "ls", "--local", "--current", "--missing", "--no-header"], miseEnv, manifest.workspacePath);
      missing = result.stdout.trim();
    } catch (error) {
      diagnostics.push(miseDiagnostic(error, configPath));
      return { env: withConfigSelector(manifest, base.env, projectPath), diagnostics };
    }
    if (missing) {
      diagnostics.push({
        severity: "error",
        message: `mise has tool versions requested by ${configPath} that are not installed.`,
        fix: `Review and trust the config if needed, then run mise install in ${manifest.workspacePath}. The manager does not install or update tools automatically.`,
      });
      return { env: withConfigSelector(manifest, base.env, projectPath), diagnostics };
    }

    return {
      env: withConfigSelector(manifest, { ...base.env, ...miseVars }, projectPath),
      diagnostics: [...diagnostics, { severity: "info", message: `Environment provider: mise (${configPath}).` }],
    };
  }
}

interface MiseCommandOutput { stdout: string; stderr: string; }

async function runMise(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<MiseCommandOutput> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const detail = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    const stderr = typeof detail.stderr === "string" ? detail.stderr : "";
    if (/not trusted|trust them with [`']?mise trust|untrusted config/i.test(stderr)) {
      throw new MiseProviderError("mise refused an untrusted project config.", true);
    }
    if (detail.killed) throw new MiseProviderError("mise environment inspection timed out.");
    throw new MiseProviderError("mise could not evaluate this Workspace config.");
  }
}

class MiseProviderError extends Error {
  constructor(message: string, readonly untrusted = false) { super(message); }
}

function miseDiagnostic(error: unknown, configPath: string): Diagnostic {
  if (error instanceof MiseProviderError && error.untrusted) {
    return {
      severity: "error",
      message: `mise refused untrusted config ${configPath}.`,
      fix: `Review the file, then explicitly approve it with mise trust ${configPath} in a terminal. The manager does not run trust commands or bypass mise policy.`,
    };
  }
  if (error instanceof MiseProviderError && error.message.includes("timed out")) {
    return { severity: "error", message: `mise timed out while inspecting ${configPath}.`, fix: "Check mise plugins/backends and trusted config hooks." };
  }
  return {
    severity: "error",
    message: `mise failed to inspect ${configPath}; its output was suppressed to avoid exposing environment values.`,
    fix: "Run `mise env --json` and `mise ls --local --current --missing` manually from the Workspace to inspect the issue.",
  };
}
