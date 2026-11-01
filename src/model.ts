import path from "node:path";

export interface HarnessManifest {
  schemaVersion: 1;
  name: string;
  description: string;
  // Legacy field name; it is the reusable Harness source root.
  workspacePath: string;
  runtimeType: string;
  executable: string;
  args: string[];
  configDirectory: string;
  configEnv: string;
  environment: {
    provider: "native" | "mise";
    inherit: string[];
    set: Record<string, string>;
  };
  dependencies: string[];
  manifestPath: string;
  managerHome: string;
}

export interface RegistryEntry {
  name: string;
  manifestPath: string;
  // Kept for registries written by the first MVP. This is the Harness source root.
  workspacePath: string;
}

export interface ProjectEntry {
  name: string;
  path: string;
  harnesses: string[];
  sourceConfigHarnesses: string[];
}

export interface Registry {
  version: 1;
  harnesses: RegistryEntry[];
  projects: ProjectEntry[];
}

export interface LaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface RuntimeResult {
  code: number;
  signal: NodeJS.Signals | null;
}

export type RuntimeStatus =
  | { state: "idle" }
  | { state: "running"; pid: number }
  | { state: "stopped"; result: RuntimeResult };

export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function isEnvName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}
