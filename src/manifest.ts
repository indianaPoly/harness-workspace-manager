import { readFile } from "node:fs/promises";
import path from "node:path";
import TOML from "@iarna/toml";
import { isEnvName, isInside, normalizeName, type HarnessManifest } from "./model.js";

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ManifestError(`${label} must be a table.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ManifestError(`${label} must be a non-empty string.`);
  }
  return value;
}

function stringArray(value: unknown, label: string, fallback: string[] = []): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ManifestError(`${label} must be an array of non-empty strings.`);
  }
  return value;
}

const protectedNames = new Set([
  "HOME", "PATH", "PWD", "TMPDIR", "TEMP", "TMP", "HWM_HOME",
  "HWM_HARNESS_ROOT", "HWM_PROJECT_ROOT", "CLAUDE_CONFIG_DIR", "CODEX_HOME",
]);
const protectedConfigNames = new Set(["HOME", "PATH", "PWD", "TMPDIR", "TEMP", "TMP", "HWM_HOME", "HWM_HARNESS_ROOT", "HWM_PROJECT_ROOT"]);

export async function loadManifest(manifestPath: string, managerHome: string): Promise<HarnessManifest> {
  const absoluteManifest = path.resolve(manifestPath);
  const absoluteManagerHome = path.resolve(managerHome);
  let parsed: unknown;
  let text: string;
  try {
    text = await readFile(absoluteManifest, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ManifestError(code === "ENOENT"
      ? `Manifest does not exist: ${absoluteManifest}`
      : `Cannot read manifest: ${absoluteManifest}`);
  }
  try {
    parsed = TOML.parse(text);
  } catch {
    throw new ManifestError(`Invalid TOML in manifest: ${absoluteManifest}`);
  }

  const root = record(parsed, "Manifest");
  const version = root.schema_version;
  if (version !== 1) throw new ManifestError("Unsupported schema_version; expected 1.");

  const name = normalizeName(string(root.name, "name"));
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    throw new ManifestError("name must use lowercase letters, numbers, dots, underscores, or hyphens, and start with a letter or number.");
  }

  const manifestDirectory = path.dirname(absoluteManifest);
  const workspaceValue = string(root.harness_path ?? root.workspace_path, "harness_path");
  const workspacePath = path.resolve(manifestDirectory, workspaceValue);
  const runtimeType = string(root.runtime_type, "runtime_type");
  const executable = string(root.executable, "executable");
  const args = stringArray(root.args, "args");
  const configEnv = string(root.config_env, "config_env");
  if (!isEnvName(configEnv) || protectedConfigNames.has(configEnv.toUpperCase()) || configEnv.toUpperCase().startsWith("MISE_")) {
    throw new ManifestError(`config_env '${configEnv}' is invalid or reserved.`);
  }

  const configValue = string(root.config_directory, "config_directory");
  const configDirectory = path.resolve(absoluteManagerHome, configValue);
  if (!isInside(absoluteManagerHome, configDirectory) || configDirectory === absoluteManagerHome) {
    throw new ManifestError("config_directory must resolve inside the manager data directory.");
  }

  const envTable = root.environment === undefined ? {} : record(root.environment, "environment");
  const provider = envTable.provider ?? "native";
  if (provider !== "native" && provider !== "mise") {
    throw new ManifestError("environment.provider must be 'native' or 'mise'.");
  }
  const inherited = stringArray(envTable.inherit, "environment.inherit");
  for (const name of inherited) {
    if (!isEnvName(name) || protectedNames.has(name.toUpperCase()) || name.toUpperCase().startsWith("MISE_")) {
      throw new ManifestError(`environment.inherit contains an invalid or reserved variable name '${name}'.`);
    }
  }
  const setTable = envTable.set === undefined ? {} : record(envTable.set, "environment.set");
  const set: Record<string, string> = {};
  for (const [key, value] of Object.entries(setTable)) {
    if (!isEnvName(key) || protectedNames.has(key.toUpperCase()) || key.toUpperCase() === configEnv.toUpperCase() || key.toUpperCase().startsWith("MISE_")) {
      throw new ManifestError(`environment.set contains an invalid, reserved, or manager-owned variable name '${key}'.`);
    }
    if (typeof value !== "string") throw new ManifestError(`environment.set.${key} must be a string.`);
    set[key] = value;
  }

  return {
    schemaVersion: 1,
    name,
    description: string(root.description, "description", "No description provided."),
    workspacePath,
    runtimeType,
    executable,
    args,
    configDirectory,
    configEnv,
    environment: { provider, inherit: inherited, set },
    dependencies: stringArray(root.dependencies, "dependencies"),
    manifestPath: absoluteManifest,
    managerHome: absoluteManagerHome,
  };
}

export function generatedManifest(options: {
  name: string;
  description: string;
  workspacePath: string;
  executable: string;
  configEnv: string;
}): string {
  const quote = (value: string) => JSON.stringify(value);
  return [
    "schema_version = 1",
    `name = ${quote(options.name)}`,
    `description = ${quote(options.description)}`,
    `harness_path = ${quote(options.workspacePath)}`,
    'runtime_type = "native"',
    `executable = ${quote(options.executable)}`,
    "args = []",
    `config_directory = ${quote(`profiles/${options.name}/config`)}`,
    `config_env = ${quote(options.configEnv)}`,
    "dependencies = []",
    "",
    "[environment]",
    'provider = "native"',
    "inherit = []",
    "",
    "[environment.set]",
    "",
  ].join("\n");
}
