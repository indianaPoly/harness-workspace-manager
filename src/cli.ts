#!/usr/bin/env node
import path from "node:path";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { access, realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RegistryStore, managerHome } from "./store.js";
import { loadManifest, ManifestError } from "./manifest.js";
import { NativeRuntimeAdapter, type Diagnostic } from "./runtime.js";
import { MiseEnvironmentProvider, NativeEnvironmentProvider } from "./environment.js";
import { CODEX_PROFILE_NAME, codexSourceProfile, writeCodexSourceProfile } from "./codex-profile.js";
import { isInside, normalizeName, type HarnessManifest, type ProjectEntry } from "./model.js";

export interface CliOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  choose?: (title: string, choices: string[]) => Promise<number>;
  ask?: (prompt: string) => Promise<string>;
}

const usage = `Usage:
  harness list
  harness start [harness-name]
  harness register [path] [--name NAME] [--description TEXT] [--executable COMMAND] [--config-env VARIABLE]
  harness add
  harness show <name>
  harness unregister <name>
  harness open <name> [--project NAME | --workspace PATH]
  harness doctor <name> [--project NAME | --workspace PATH]
  harness project register <path> [--name NAME] [--harness NAME ...] [--use-harness-config NAME ...]
  harness project list | show <name> | doctor <name>
  harness project attach <project> <harness> [--use-harness-config]
  harness project detach <project> <harness> | unregister <name>
  harness project activate <project> <harness> | deactivate <project> <harness>
  harness project open <project> --harness <name>
  harness --help

register stores a reusable Harness source. A Project can attach several Harnesses without changing Project files. Relative harness_path values resolve from the manifest directory; relative config_directory values resolve from the manager data directory.
--use-harness-config NAME explicitly applies that Codex Harness's allowed source config and skills to its Project link. Review the source first: MCP servers and hooks can run commands.
`;

export async function runCli(argv: string[], options: CliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((text) => process.stdout.write(`${text}\n`));
  const stderr = options.stderr ?? ((text) => process.stderr.write(`${text}\n`));
  const env = options.env ?? process.env;
  const store = new RegistryStore(options.home ?? managerHome(env));
  const args = argv[0] === "harness" ? argv.slice(1) : [...argv];
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    stdout(usage.trimEnd());
    return 0;
  }

  const command = args.shift();
  try {
    switch (command) {
      case "list": {
        requireNoArgs(args, "harness list");
        const registry = await store.load();
        if (!registry.harnesses.length) {
          stdout("No Harnesses registered.");
          return 0;
        }
        const rows = await Promise.all(registry.harnesses.map(async (entry) => {
          try {
            const manifest = await loadManifest(entry.manifestPath, store.home);
            return `${manifest.name}\t${manifest.runtimeType}\t${manifest.environment.provider}\t${manifest.workspacePath}`;
          } catch {
            return `${entry.name}\tINVALID\tINVALID\t${entry.workspacePath}`;
          }
        }));
        stdout(`NAME\tRUNTIME\tENVIRONMENT\tHARNESS SOURCE\n${rows.join("\n")}`);
        return 0;
      }
      case "register": {
        if (!args.length) {
          await interactiveRegister(store, options.cwd ?? process.cwd(), stdout, options.ask);
          return 0;
        }
        const parsed = parseRegisterArgs(args);
        const manifest = await store.register(path.resolve(options.cwd ?? process.cwd(), parsed.workspace), parsed.overrides);
        stdout(`Registered '${manifest.name}'.`);
        stdout(`Harness source: ${manifest.workspacePath}`);
        stdout(`Manifest: ${manifest.manifestPath}`);
        stdout(`Config directory: ${manifest.configDirectory}`);
        stdout("The source workspace was not copied or modified.");
        return 0;
      }
      case "add": {
        requireNoArgs(args, "harness add");
        await interactiveRegister(store, options.cwd ?? process.cwd(), stdout, options.ask);
        return 0;
      }
      case "show": {
        const name = requireOneArg(args, "harness show <name>");
        const manifest = await findManifest(store, name);
        printManifest(stdout, manifest);
        return 0;
      }
      case "unregister": {
        const name = requireOneArg(args, "harness unregister <name>");
        const didRemove = await store.unregister(name);
        if (!didRemove) throw new Error(`Harness '${name}' is not registered.`);
        stdout(`Unregistered '${normalizeName(name)}'.`);
        stdout("The workspace, manifest, and config state were preserved.");
        return 0;
      }
      case "doctor": {
        const selection = parseRunArgs(args, "doctor");
        return await runHarness(store, selection.name, "doctor", selection, env, options.cwd ?? process.cwd(), stdout, stderr);
      }
      case "open": {
        const selection = parseRunArgs(args, "open");
        return await runHarness(store, selection.name, "open", selection, env, options.cwd ?? process.cwd(), stdout, stderr);
      }
      case "start": {
        if (args.length > 1) throw new Error("Expected: harness start [harness-name].");
        return await startInteractive(store, args[0], env, options.cwd ?? process.cwd(), stdout, stderr, options.choose, options.ask);
      }
      case "project": {
        return await runProjectCommand(store, args, env, options.cwd ?? process.cwd(), stdout, stderr);
      }
      default:
        throw new Error(`Unknown command '${command}'. Run 'harness --help' for usage.`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    stderr(`harness: ${detail}`);
    if (error instanceof ManifestError) stderr("Fix the manifest at the reported path, then retry.");
    return 1;
  }
}

async function findManifest(store: RegistryStore, name: string): Promise<HarnessManifest> {
  const normalized = normalizeName(name);
  const registry = await store.load();
  const entry = registry.harnesses.find((item) => normalizeName(item.name) === normalized);
  if (!entry) throw new Error(`Harness '${name}' is not registered.`);
  return loadManifest(entry.manifestPath, store.home);
}

interface RunSelection {
  name: string;
  projectName?: string;
  workspacePath?: string;
}

interface ProjectTarget {
  path: string;
  sourceConfigActive: boolean;
}

function parseRunArgs(args: string[], command: "open" | "doctor"): RunSelection {
  if (!args.length || args[0]!.startsWith("-")) throw new Error(`Expected: harness ${command} <name> [--project NAME | --workspace PATH]`);
  const selection: RunSelection = { name: args.shift()! };
  while (args.length) {
    const flag = args.shift();
    const value = args.shift();
    if (!value || value.startsWith("--")) throw new Error(`Option '${flag}' requires a value.`);
    if (flag === "--project" && !selection.projectName) selection.projectName = value;
    else if (flag === "--workspace" && !selection.workspacePath) selection.workspacePath = value;
    else throw new Error(`Unknown or repeated ${command} option '${flag}'.`);
  }
  if (selection.projectName && selection.workspacePath) throw new Error("Choose either --project or --workspace.");
  return selection;
}

async function projectTarget(store: RegistryStore, manifest: HarnessManifest, selection: RunSelection, callerCwd: string, mode: "open" | "doctor"): Promise<ProjectTarget> {
  const registry = await store.load();
  if (selection.projectName) {
    const project = registry.projects.find((entry) => entry.name === normalizeName(selection.projectName!));
    if (!project) throw new Error(`Project '${selection.projectName}' is not registered.`);
    if (!project.harnesses.includes(manifest.name)) throw new Error(`Harness '${manifest.name}' is not attached to Project '${project.name}'.`);
    return { path: project.path, sourceConfigActive: project.sourceConfigHarnesses.includes(manifest.name) };
  }
  if (selection.workspacePath) {
    const candidate = path.resolve(callerCwd, selection.workspacePath);
    try {
      if (!(await stat(candidate)).isDirectory()) throw new Error(`Project is not a directory: ${candidate}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Project path does not exist: ${candidate}`);
      throw error;
    }
    return { path: await realpath(candidate), sourceConfigActive: false };
  }
  const cwd = await realpath(callerCwd).catch(() => path.resolve(callerCwd));
  const enclosing = registry.projects.filter((project) => isInside(project.path, cwd)).sort((a, b) => b.path.length - a.path.length);
  if (enclosing.length) {
    const project = enclosing[0]!;
    if (!project.harnesses.includes(manifest.name)) throw new Error(`Harness '${manifest.name}' is not attached to Project '${project.name}'.`);
    return { path: project.path, sourceConfigActive: project.sourceConfigHarnesses.includes(manifest.name) };
  }
  if (mode === "doctor" || isInside(manifest.workspacePath, cwd)) return { path: manifest.workspacePath, sourceConfigActive: false };
  throw new Error(`No linked Project found for '${callerCwd}'. Register it with 'harness project register <path> --harness ${manifest.name}' or pass --workspace PATH.`);
}

async function runHarness(store: RegistryStore, name: string, mode: "open" | "doctor", selection: RunSelection, env: NodeJS.ProcessEnv, callerCwd: string, stdout: (text: string) => void, stderr: (text: string) => void): Promise<number> {
  const manifest = await findManifest(store, name);
  const target = await projectTarget(store, manifest, selection, callerCwd, mode);
  const all = await store.manifests();
  const environment = await resolveEnvironment(manifest, env, target.path);
  const runtime = new NativeRuntimeAdapter();
  const diagnostics = [...environment.diagnostics, ...await runtime.validate(manifest, all, environment.env, target.path)];
  const cliName = path.basename(manifest.executable).replace(/\.exe$/i, "").toLowerCase();
  let codexProfile: string | undefined;
  if (target.sourceConfigActive) {
    if (manifest.args.includes("--profile") || manifest.args.includes("-p")) throw new Error(`Harness '${manifest.name}' already selects a Codex profile; remove that argument before source config activation.`);
    codexProfile = await codexSourceProfile(manifest);
    diagnostics.push({ severity: "info", message: `User-selected Codex source config will be applied from ${manifest.workspacePath}.` });
  } else if (target.path !== manifest.workspacePath && ["codex", "claude"].includes(cliName)) {
    const projectConfig = path.join(manifest.workspacePath, cliName === "codex" ? ".codex/config.toml" : ".claude/settings.json");
    try {
      await access(projectConfig);
      diagnostics.push({ severity: mode === "doctor" ? "error" : "warning", message: `Harness source config ${projectConfig} is project-scoped and is not loaded from ${target.path}. Use a Harness launcher or explicitly activate the source config for this Project.` });
    } catch { /* no source-scoped CLI config */ }
  }
  if (mode === "doctor" || diagnostics.some((item) => item.severity === "error")) {
    printDiagnostics(stdout, stderr, diagnostics);
    return diagnostics.some((item) => item.severity === "error") ? 1 : 0;
  }
  printDiagnostics(stdout, stderr, diagnostics);
  const spec = await runtime.prepare(manifest, environment.env, target.path);
  if (codexProfile) {
    await writeCodexSourceProfile(manifest, codexProfile);
    spec.args.unshift("--profile", CODEX_PROFILE_NAME);
  }
  try {
    const result = await runtime.start(spec);
    if (result.signal) stderr(`Harness ended after signal ${result.signal} (exit ${result.code}).`);
    return result.code;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not start '${manifest.executable}': ${detail}`);
  }
}

async function runProjectCommand(store: RegistryStore, args: string[], env: NodeJS.ProcessEnv, callerCwd: string, stdout: (text: string) => void, stderr: (text: string) => void): Promise<number> {
  const command = args.shift();
  switch (command) {
    case "list": {
      requireNoArgs(args, "harness project list");
      const projects = (await store.load()).projects;
      if (!projects.length) { stdout("No Projects registered."); return 0; }
      stdout(`NAME\tHARNESSES\tSOURCE CONFIG\tPATH\n${projects.map((project) => `${project.name}\t${project.harnesses.join(", ") || "(none)"}\t${project.sourceConfigHarnesses.join(", ") || "(none)"}\t${project.path}`).join("\n")}`);
      return 0;
    }
    case "register": {
      if (!args.length || args[0]!.startsWith("--")) throw new Error("Expected: harness project register <path> [--name NAME] [--harness NAME ...] [--use-harness-config NAME ...]");
      const candidate = path.resolve(callerCwd, args.shift()!);
      let name: string | undefined;
      const harnesses: string[] = [];
      const sourceConfigHarnesses: string[] = [];
      while (args.length) {
        const flag = args.shift();
        const value = args.shift();
        if (!value || value.startsWith("--")) throw new Error(`Option '${flag}' requires a value.`);
        if (flag === "--name" && !name) name = value;
        else if (flag === "--harness") harnesses.push(value);
        else if (flag === "--use-harness-config") sourceConfigHarnesses.push(value);
        else throw new Error(`Unknown or repeated project register option '${flag}'.`);
      }
      const project = await store.registerProject(candidate, name, harnesses, sourceConfigHarnesses);
      printProject(stdout, project);
      stdout("Project files were not modified.");
      return 0;
    }
    case "show": {
      const name = requireOneArg(args, "harness project show <name>");
      const project = (await store.load()).projects.find((entry) => entry.name === normalizeName(name));
      if (!project) throw new Error(`Project '${name}' is not registered.`);
      printProject(stdout, project);
      return 0;
    }
    case "doctor": {
      const name = requireOneArg(args, "harness project doctor <name>");
      const project = (await store.load()).projects.find((entry) => entry.name === normalizeName(name));
      if (!project) throw new Error(`Project '${name}' is not registered.`);
      if (!project.harnesses.length) throw new Error(`Project '${name}' has no attached Harnesses.`);
      let failed = false;
      for (const harness of project.harnesses) {
        stdout(`Harness: ${harness}`);
        try {
          if (await runHarness(store, harness, "doctor", { name: harness, projectName: project.name }, env, callerCwd, stdout, stderr)) failed = true;
        } catch (error) {
          failed = true;
          stderr(`harness: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return failed ? 1 : 0;
    }
    case "attach": {
      if (args.length !== 2 && !(args.length === 3 && args[2] === "--use-harness-config")) throw new Error("Expected: harness project attach <project> <harness> [--use-harness-config]");
      printProject(stdout, await store.attachProject(args[0]!, args[1]!, args.length === 3));
      return 0;
    }
    case "detach": {
      if (args.length !== 2) throw new Error("Expected: harness project detach <project> <harness>");
      printProject(stdout, await store.detachProject(args[0]!, args[1]!));
      return 0;
    }
    case "activate":
    case "deactivate": {
      if (args.length !== 2) throw new Error(`Expected: harness project ${command} <project> <harness>`);
      printProject(stdout, await store.setSourceConfigActivation(args[0]!, args[1]!, command === "activate"));
      return 0;
    }
    case "unregister": {
      const name = requireOneArg(args, "harness project unregister <name>");
      if (!(await store.unregisterProject(name))) throw new Error(`Project '${name}' is not registered.`);
      stdout(`Unregistered Project '${normalizeName(name)}'. Project files and Harness profiles were preserved.`);
      return 0;
    }
    case "open": {
      if (args.length !== 3 || args[1] !== "--harness") throw new Error("Expected: harness project open <project> --harness <name>");
      return runHarness(store, args[2]!, "open", { name: args[2]!, projectName: args[0]! }, env, callerCwd, stdout, stderr);
    }
    default: throw new Error(`Unknown project command '${command}'. Run 'harness --help' for usage.`);
  }
}

async function startInteractive(
  store: RegistryStore,
  preselectedHarness: string | undefined,
  env: NodeJS.ProcessEnv,
  callerCwd: string,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
  choose?: (title: string, choices: string[]) => Promise<number>,
  ask?: (prompt: string) => Promise<string>,
): Promise<number> {
  const registry = await store.load();
  let manifests = await store.manifests();
  if (!manifests.length) {
    const added = await interactiveRegister(store, callerCwd, stdout, ask);
    if (!added) { stdout("Cancelled."); return 0; }
    manifests = await store.manifests();
  }
  if (preselectedHarness && !manifests.some((manifest) => manifest.name === normalizeName(preselectedHarness))) {
    throw new Error(`Harness '${preselectedHarness}' is not registered.`);
  }

  const canonicalCwd = await realpath(callerCwd).catch(() => path.resolve(callerCwd));
  const currentProject = registry.projects
    .filter((project) => isInside(project.path, canonicalCwd))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const projects = [...registry.projects].sort((a, b) => {
    if (a.name === currentProject?.name) return -1;
    if (b.name === currentProject?.name) return 1;
    return a.name.localeCompare(b.name);
  });
  const projectChoices = projects.map((project) => `${project.name} — ${project.path}${project.name === currentProject?.name ? " (current)" : ""}`);
  const currentProjectName = currentProject?.name ?? projectNameFromPath(canonicalCwd);
  projectChoices.push(currentProject
    ? `Use current Project: ${currentProjectName}`
    : `Register current folder as Project: ${currentProjectName} (${canonicalCwd})`);

  const projectChoice = await selectChoice(choose, "Choose a Project", projectChoices);
  if (projectChoice < 0 || projectChoice >= projectChoices.length) {
    stdout("Cancelled.");
    return 0;
  }
  let project: ProjectEntry;
  if (projectChoice === projectChoices.length - 1) {
    if (currentProject) project = currentProject;
    else project = await store.registerProject(canonicalCwd, currentProjectName);
  } else {
    project = projects[projectChoice]!;
  }

  const harnessChoices = manifests.map((manifest) =>
    `${manifest.name} — ${manifest.description}${project.harnesses.includes(manifest.name) ? " (attached)" : " (attach on use)"}`);
  if (!preselectedHarness) harnessChoices.push("Register another Harness");
  let harnessIndex = preselectedHarness
    ? manifests.findIndex((manifest) => manifest.name === normalizeName(preselectedHarness))
    : await selectChoice(choose, `Choose a Harness for Project '${project.name}'`, harnessChoices);
  if (!preselectedHarness && harnessIndex === manifests.length) {
    const added = await interactiveRegister(store, callerCwd, stdout, ask);
    if (!added) { stdout("Cancelled."); return 0; }
    manifests = await store.manifests();
    harnessIndex = manifests.findIndex((manifest) => manifest.name === added.name);
  }
  if (harnessIndex < 0 || harnessIndex >= manifests.length) {
    if (preselectedHarness) throw new Error(`Harness '${preselectedHarness}' is not registered.`);
    stdout("Cancelled.");
    return 0;
  }
  const manifest = manifests[harnessIndex]!;
  if (!project.harnesses.includes(manifest.name)) project = await store.attachProject(project.name, manifest.name);

  if (manifest.configEnv.toUpperCase() === "CODEX_HOME" && !project.sourceConfigHarnesses.includes(manifest.name)) {
    const sourceConfig = path.join(manifest.workspacePath, ".codex", "config.toml");
    try {
      await access(sourceConfig);
      const activate = await selectChoice(choose,
        `Apply the reviewed Codex config and Skills from ${manifest.workspacePath} to this Project? MCP and Hooks may run commands.`,
        ["Apply Harness source config for this Project", "Use the bare Codex CLI profile"]);
      if (activate < 0) { stdout("Cancelled."); return 0; }
      if (activate === 0) project = await store.setSourceConfigActivation(project.name, manifest.name, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  if (!choose) stdout(`Starting '${manifest.name}' in Project '${project.name}'.`);
  return runHarness(store, manifest.name, "open", { name: manifest.name, projectName: project.name }, env, callerCwd, stdout, stderr);
}

async function interactiveRegister(
  store: RegistryStore,
  callerCwd: string,
  stdout: (text: string) => void,
  ask?: (prompt: string) => Promise<string>,
): Promise<HarnessManifest | undefined> {
  const pathInput = await askLine(ask, `Harness folder [${callerCwd}]: `);
  if (pathInput === undefined) return undefined;
  const sourcePath = path.resolve(callerCwd, pathInput.trim() || callerCwd);
  const localManifest = path.join(sourcePath, "harness.toml");
  let hasLocalManifest = false;
  try { await access(localManifest); hasLocalManifest = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let overrides: { name?: string } = {};
  if (!hasLocalManifest) {
    const suggested = projectNameFromPath(sourcePath);
    const name = await askLine(ask, `Harness name [${suggested}]: `);
    if (name === undefined) return undefined;
    if (name.trim()) overrides = { name: name.trim() };
  }
  const manifest = await store.register(sourcePath, overrides);
  stdout(`Registered '${manifest.name}' from ${manifest.workspacePath}.`);
  stdout(`Manager Manifest: ${manifest.manifestPath}`);
  return manifest;
}

async function askLine(ask: ((prompt: string) => Promise<string>) | undefined, prompt: string): Promise<string | undefined> {
  if (ask) return ask(prompt);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Harness registration needs an interactive terminal or an explicit 'harness register <path>' command.");
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try { return await readline.question(prompt); }
  catch { return undefined; }
  finally { readline.close(); }
}

async function selectChoice(choose: ((title: string, choices: string[]) => Promise<number>) | undefined, title: string, choices: string[]): Promise<number> {
  if (!choices.length) return -1;
  if (choose) return choose(title, choices);
  return terminalChoice(title, choices);
}

function terminalChoice(title: string, choices: string[]): Promise<number> {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("harness start needs an interactive terminal. Use 'harness open <name> --project <project>' or 'harness project open <project> --harness <name>'.");
  }
  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  const wasFlowing = input.readableFlowing;
  let selected = 0;
  const render = () => {
    output.write("\u001b[2J\u001b[H");
    output.write(`${title}\n\n`);
    choices.forEach((choice, index) => output.write(`${index === selected ? "›" : " "} ${choice}\n`));
    output.write("\n↑/↓ move · Enter select · Esc cancel\n");
  };

  return new Promise((resolve) => {
    const finish = (value: number) => {
      input.off("keypress", onKeypress);
      input.setRawMode(wasRaw ?? false);
      input.pause();
      if (wasFlowing === true) input.resume();
      output.write("\u001b[?25h\n");
      resolve(value);
    };
    const onKeypress = (character: string, key: { name?: string; ctrl?: boolean }) => {
      if ((key.ctrl && key.name === "c") || key.name === "escape" || character === "q") return finish(-1);
      if (key.name === "up" || character === "k") selected = (selected + choices.length - 1) % choices.length;
      else if (key.name === "down" || character === "j") selected = (selected + 1) % choices.length;
      else if (key.name === "return" || key.name === "enter") return finish(selected);
      else if (/^[1-9]$/.test(character)) {
        const index = Number(character) - 1;
        if (index < choices.length) return finish(index);
      }
      render();
    };
    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKeypress);
    output.write("\u001b[?25l");
    render();
  });
}

function projectNameFromPath(projectPath: string): string {
  const name = path.basename(projectPath).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return name || "project";
}

function printProject(write: (text: string) => void, project: ProjectEntry): void {
  write(`Project: ${project.name}`);
  write(`Path: ${project.path}`);
  write(`Harnesses: ${project.harnesses.join(", ") || "(none)"}`);
  write(`Source configs explicitly activated: ${project.sourceConfigHarnesses.join(", ") || "(none)"}`);
}

function requireOneArg(args: string[], usageText: string): string {
  if (args.length !== 1 || !args[0] || args[0].startsWith("-")) throw new Error(`Expected: ${usageText}`);
  return args[0];
}

function requireNoArgs(args: string[], usageText: string): void {
  if (args.length) throw new Error(`Unexpected argument '${args[0]}'. Expected: ${usageText}`);
}

function parseRegisterArgs(args: string[]): { workspace: string; overrides: { name?: string; description?: string; executable?: string; configEnv?: string } } {
  if (!args.length || args[0]!.startsWith("-")) throw new Error("Expected: harness register <path>.");
  const workspace = args.shift()!;
  const overrides: { name?: string; description?: string; executable?: string; configEnv?: string } = {};
  const flags: Record<string, keyof typeof overrides> = {
    "--name": "name",
    "--description": "description",
    "--executable": "executable",
    "--config-env": "configEnv",
  };
  while (args.length) {
    const flag = args.shift()!;
    const field = flags[flag];
    if (!field) throw new Error(`Unknown register option '${flag}'.`);
    const value = args.shift();
    if (!value || value.startsWith("--")) throw new Error(`Option '${flag}' requires a value.`);
    if (overrides[field] !== undefined) throw new Error(`Option '${flag}' was supplied more than once.`);
    Object.assign(overrides, { [field]: value });
  }
  return { workspace, overrides };
}

function printManifest(write: (text: string) => void, manifest: HarnessManifest): void {
  const envNames = [...manifest.environment.inherit, ...Object.keys(manifest.environment.set)];
  write(`Name: ${manifest.name}`);
  write(`Description: ${manifest.description}`);
  write(`Harness source: ${manifest.workspacePath}`);
  write(`Runtime type: ${manifest.runtimeType}`);
  write(`Executable: ${manifest.executable}`);
  write(`Arguments: ${manifest.args.length ? manifest.args.join(" ") : "(none)"}`);
  write(`Config directory: ${manifest.configDirectory}`);
  write(`Config environment variable: ${manifest.configEnv}`);
  write(`Environment provider: ${manifest.environment.provider}`);
  write(`Environment variable names: ${envNames.length ? [...new Set(envNames)].join(", ") : "(none)"}`);
  write(`Required dependencies: ${manifest.dependencies.length ? manifest.dependencies.join(", ") : "(none)"}`);
  write(`Manifest path: ${manifest.manifestPath}`);
}

async function resolveEnvironment(manifest: HarnessManifest, env: NodeJS.ProcessEnv, projectPath = manifest.workspacePath) {
  const provider = manifest.environment.provider === "mise"
    ? new MiseEnvironmentProvider()
    : new NativeEnvironmentProvider();
  return provider.resolve(manifest, env, projectPath);
}

function printDiagnostics(stdout: (text: string) => void, stderr: (text: string) => void, diagnostics: Diagnostic[]): void {
  if (!diagnostics.length) {
    stdout("Doctor: all checks passed.");
    return;
  }
  for (const item of diagnostics) {
    const line = `${item.severity.toUpperCase()}: ${item.message}${item.fix ? `\n  Fix: ${item.fix}` : ""}`;
    (item.severity === "error" ? stderr : stdout)(line);
  }
}

async function directMain(): Promise<void> {
  if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const callerCwd = process.env.INIT_CWD && path.resolve(process.cwd()) === packageRoot
      ? path.resolve(process.env.INIT_CWD)
      : process.cwd();
    process.exitCode = await runCli(process.argv.slice(2), { cwd: callerCwd });
  }
}

void directMain();
