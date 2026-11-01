import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeName, type HarnessManifest, type ProjectEntry, type Registry } from "./model.js";
import { generatedManifest, loadManifest } from "./manifest.js";
import { codexSourceProfile } from "./codex-profile.js";

export function managerHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HWM_HOME) return path.resolve(env.HWM_HOME);
  if (process.platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Harness Workspace Manager");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Harness Workspace Manager");
  }
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "harness-workspace-manager");
}

export class RegistryStore {
  readonly home: string;
  private readonly registryPath: string;

  constructor(home = managerHome()) {
    this.home = path.resolve(home);
    this.registryPath = path.join(this.home, "registry.json");
  }

  async load(): Promise<Registry> {
    let text: string;
    try {
      text = await readFile(this.registryPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, harnesses: [], projects: [] };
      throw error;
    }
    try {
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
      const registry = value as Partial<Registry>;
      if (registry.version !== 1 || !Array.isArray(registry.harnesses)) throw new Error("unsupported registry shape");
      for (const entry of registry.harnesses) {
        if (!entry || typeof entry.name !== "string" || typeof entry.manifestPath !== "string" || typeof entry.workspacePath !== "string") {
          throw new Error("invalid registry entry");
        }
      }
      const projects = registry.projects ?? [];
      if (!Array.isArray(projects)) throw new Error("invalid projects list");
      for (const project of projects) {
        if (!project || typeof project.name !== "string" || typeof project.path !== "string" ||
            !Array.isArray(project.harnesses) || project.harnesses.some((name) => typeof name !== "string") ||
            (project.sourceConfigHarnesses !== undefined && (!Array.isArray(project.sourceConfigHarnesses) || project.sourceConfigHarnesses.some((name: unknown) => typeof name !== "string")))) {
          throw new Error("invalid project entry");
        }
      }
      return { version: 1, harnesses: registry.harnesses, projects: projects.map((project) => ({ ...project, sourceConfigHarnesses: project.sourceConfigHarnesses ?? [] })) } as Registry;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "invalid JSON";
      throw new Error(`Registry is invalid at ${this.registryPath}: ${detail}`);
    }
  }

  async manifests(): Promise<HarnessManifest[]> {
    const registry = await this.load();
    const results: HarnessManifest[] = [];
    for (const entry of registry.harnesses) results.push(await loadManifest(entry.manifestPath, this.home));
    return results;
  }

  async register(workspacePath: string, overrides: {
    name?: string;
    description?: string;
    executable?: string;
    configEnv?: string;
  } = {}): Promise<HarnessManifest> {
    const workspace = path.resolve(workspacePath);
    const { stat, realpath } = await import("node:fs/promises");
    const workspaceStat = await stat(workspace);
    if (!workspaceStat.isDirectory()) throw new Error(`Workspace is not a directory: ${workspace}`);
    const canonicalWorkspace = await realpath(workspace);
    const localManifest = path.join(canonicalWorkspace, "harness.toml");
    const registry = await this.load();
    let manifestPath: string;
    try {
      await stat(localManifest);
      if (overrides.name || overrides.description || overrides.executable || overrides.configEnv) {
        throw new Error("harness.toml owns this workspace's settings; edit it directly or omit registration overrides.");
      }
      manifestPath = localManifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const rawName = overrides.name ?? (path.basename(canonicalWorkspace).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "harness");
      const name = normalizeName(rawName);
      if (registry.harnesses.some((item) => normalizeName(item.name) === name)) {
        throw new Error(`Harness '${name}' is already registered.`);
      }
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
        throw new Error("name must use lowercase letters, numbers, dots, underscores, or hyphens, and start with a letter or number.");
      }
      const existingManifest = path.join(this.home, "harnesses", name, "manifest.toml");
      try {
        await stat(existingManifest);
        throw new Error(`A manager-owned manifest already exists for '${name}' but is not registered; inspect ${existingManifest} before reusing it.`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const detected = await detectRuntime(canonicalWorkspace);
      const configEnv = overrides.configEnv ?? detected.configEnv;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(configEnv) || ["HOME", "PATH", "PWD", "TMPDIR", "TEMP", "TMP", "HWM_HOME"].includes(configEnv.toUpperCase()) || configEnv.toUpperCase().startsWith("MISE_")) {
        throw new Error(`Invalid or reserved config environment variable '${configEnv}'.`);
      }
      const body = generatedManifest({
        name,
        description: overrides.description ?? `Harness registered from ${canonicalWorkspace}`,
        workspacePath: canonicalWorkspace,
        executable: overrides.executable ?? detected.executable,
        configEnv,
      });
      await this.writeAtomic(existingManifest, body);
      manifestPath = existingManifest;
    }

    const manifest = await loadManifest(manifestPath, this.home);
    if (registry.harnesses.some((item) => normalizeName(item.name) === manifest.name)) {
      throw new Error(`Harness '${manifest.name}' is already registered.`);
    }
    const configs = await Promise.all(registry.harnesses.map((item) => loadManifest(item.manifestPath, this.home)));
    if (configs.some((item) => path.resolve(item.configDirectory) === path.resolve(manifest.configDirectory))) {
      throw new Error(`Config directory is already assigned to another Harness: ${manifest.configDirectory}`);
    }
    await this.save({
      version: 1,
      harnesses: [...registry.harnesses, {
        name: manifest.name,
        manifestPath,
        workspacePath: manifest.workspacePath,
      }],
      projects: registry.projects,
    });
    return manifest;
  }

  async unregister(name: string): Promise<boolean> {
    const normalized = normalizeName(name);
    const registry = await this.load();
    const linked = registry.projects.find((project) => project.harnesses.includes(normalized));
    if (linked) throw new Error(`Harness '${normalized}' is attached to Project '${linked.name}'; detach it first.`);
    const remaining = registry.harnesses.filter((entry) => normalizeName(entry.name) !== normalized);
    if (remaining.length === registry.harnesses.length) return false;
    await this.save({ ...registry, harnesses: remaining });
    return true;
  }

  async registerProject(projectPath: string, name?: string, harnesses: string[] = [], sourceConfigHarnesses: string[] = []): Promise<ProjectEntry> {
    const { realpath, stat } = await import("node:fs/promises");
    const candidate = path.resolve(projectPath);
    try {
      if (!(await stat(candidate)).isDirectory()) throw new Error(`Project is not a directory: ${candidate}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Project path does not exist: ${candidate}`);
      throw error;
    }
    const canonical = await realpath(candidate);
    const projectName = normalizeName(name ?? path.basename(canonical).replace(/[^a-zA-Z0-9._-]+/g, "-"));
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(projectName)) throw new Error("Project name must be a lowercase slug.");
    const registry = await this.load();
    if (registry.projects.some((project) => project.name === projectName)) throw new Error(`Project '${projectName}' is already registered.`);
    if (registry.projects.some((project) => project.path === canonical)) throw new Error(`Project path is already registered: ${canonical}`);
    const linked = [...new Set(harnesses.map(normalizeName))];
    for (const harness of linked) {
      if (!registry.harnesses.some((entry) => entry.name === harness)) throw new Error(`Harness '${harness}' is not registered.`);
    }
    const activated = [...new Set(sourceConfigHarnesses.map(normalizeName))];
    for (const harness of activated) {
      if (!linked.includes(harness)) throw new Error(`Harness '${harness}' must be attached before its source config can be activated.`);
      await this.validateSourceConfigHarness(harness, registry);
    }
    const project = { name: projectName, path: canonical, harnesses: linked, sourceConfigHarnesses: activated };
    await this.save({ ...registry, projects: [...registry.projects, project] });
    return project;
  }

  async attachProject(projectName: string, harnessName: string, activateSourceConfig = false): Promise<ProjectEntry> {
    const registry = await this.load();
    const project = registry.projects.find((entry) => entry.name === normalizeName(projectName));
    if (!project) throw new Error(`Project '${projectName}' is not registered.`);
    const harness = normalizeName(harnessName);
    if (!registry.harnesses.some((entry) => entry.name === harness)) throw new Error(`Harness '${harnessName}' is not registered.`);
    if (project.harnesses.includes(harness)) throw new Error(`Harness '${harness}' is already attached to Project '${project.name}'.`);
    if (activateSourceConfig) await this.validateSourceConfigHarness(harness, registry);
    const updated = { ...project, harnesses: [...project.harnesses, harness], sourceConfigHarnesses: activateSourceConfig ? [...project.sourceConfigHarnesses, harness] : project.sourceConfigHarnesses };
    await this.save({ ...registry, projects: registry.projects.map((entry) => entry.name === project.name ? updated : entry) });
    return updated;
  }

  async detachProject(projectName: string, harnessName: string): Promise<ProjectEntry> {
    const registry = await this.load();
    const project = registry.projects.find((entry) => entry.name === normalizeName(projectName));
    if (!project) throw new Error(`Project '${projectName}' is not registered.`);
    const harness = normalizeName(harnessName);
    if (!project.harnesses.includes(harness)) throw new Error(`Harness '${harness}' is not attached to Project '${project.name}'.`);
    const updated = { ...project, harnesses: project.harnesses.filter((name) => name !== harness), sourceConfigHarnesses: project.sourceConfigHarnesses.filter((name) => name !== harness) };
    await this.save({ ...registry, projects: registry.projects.map((entry) => entry.name === project.name ? updated : entry) });
    return updated;
  }

  async setSourceConfigActivation(projectName: string, harnessName: string, enabled: boolean): Promise<ProjectEntry> {
    const registry = await this.load();
    const project = registry.projects.find((entry) => entry.name === normalizeName(projectName));
    if (!project) throw new Error(`Project '${projectName}' is not registered.`);
    const harness = normalizeName(harnessName);
    if (!project.harnesses.includes(harness)) throw new Error(`Harness '${harness}' is not attached to Project '${project.name}'.`);
    if (enabled) await this.validateSourceConfigHarness(harness, registry);
    const sourceConfigHarnesses = enabled
      ? [...new Set([...project.sourceConfigHarnesses, harness])]
      : project.sourceConfigHarnesses.filter((name) => name !== harness);
    const updated = { ...project, sourceConfigHarnesses };
    await this.save({ ...registry, projects: registry.projects.map((entry) => entry.name === project.name ? updated : entry) });
    return updated;
  }

  async unregisterProject(name: string): Promise<boolean> {
    const registry = await this.load();
    const projects = registry.projects.filter((entry) => entry.name !== normalizeName(name));
    if (projects.length === registry.projects.length) return false;
    await this.save({ ...registry, projects });
    return true;
  }

  private async validateSourceConfigHarness(name: string, registry: Registry): Promise<void> {
    const entry = registry.harnesses.find((item) => item.name === name)!;
    const manifest = await loadManifest(entry.manifestPath, this.home);
    const executable = path.basename(manifest.executable).replace(/\.exe$/i, "").toLowerCase();
    if (executable !== "codex" || manifest.configEnv.toUpperCase() !== "CODEX_HOME") {
      throw new Error(`Source config activation currently supports Codex Harnesses only; '${name}' should provide a launcher script.`);
    }
    await codexSourceProfile(manifest);
  }

  async save(registry: Registry): Promise<void> {
    await this.writeAtomic(this.registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  }

  private async writeAtomic(destination: string, contents: string): Promise<void> {
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

async function detectRuntime(workspace: string): Promise<{ executable: string; configEnv: string }> {
  const { access } = await import("node:fs/promises");
  try {
    await access(path.join(workspace, ".codex", "config.toml"));
    return { executable: "codex", configEnv: "CODEX_HOME" };
  } catch { /* continue */ }
  try {
    await access(path.join(workspace, ".claude", "settings.json"));
    return { executable: "claude", configEnv: "CLAUDE_CONFIG_DIR" };
  } catch { /* use Claude Code as the sensible default */ }
  return { executable: "claude", configEnv: "CLAUDE_CONFIG_DIR" };
}

