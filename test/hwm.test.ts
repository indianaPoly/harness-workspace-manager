import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RegistryStore } from "../src/store.js";
import { loadManifest } from "../src/manifest.js";
import { NativeRuntimeAdapter } from "../src/runtime.js";
import { runCli } from "../src/cli.js";

interface Fixture {
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
  output: string[];
  errors: string[];
  run(args: string[]): Promise<number>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hwm-test-"));
  const home = path.join(root, "manager");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || "",
    HOME: path.join(root, "host-home"),
    LANG: "C",
    HWM_TEST_SECRET: "synthetic-only",
    HWM_TEST_INHERITED: "explicitly-allowed",
    CLAUDE_CONFIG_DIR: "/host/claude-config",
    CODEX_HOME: "/host/codex-home",
  };
  const output: string[] = [];
  const errors: string[] = [];
  await mkdir(env.HOME!, { recursive: true });
  return {
    root, home, env, output, errors,
    run: (args) => runCli(args, { home, cwd: root, env, stdout: (line) => output.push(line), stderr: (line) => errors.push(line) }),
  };
}

function manifestText(options: {
  name: string;
  configDirectory?: string;
  configEnv?: string;
  executable?: string;
  args?: string[];
  inherit?: string[];
  set?: Record<string, string>;
  dependencies?: string[];
}): string {
  const assignments = Object.entries(options.set ?? {})
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join("\n");
  return [
    "schema_version = 1",
    `name = ${JSON.stringify(options.name)}`,
    `description = ${JSON.stringify(`Synthetic ${options.name} Harness`)}`,
    'workspace_path = "."',
    'runtime_type = "native"',
    `executable = ${JSON.stringify(options.executable ?? process.execPath)}`,
    `args = ${JSON.stringify(options.args ?? [])}`,
    `config_directory = ${JSON.stringify(options.configDirectory ?? `profiles/${options.name}/config`)}`,
    `config_env = ${JSON.stringify(options.configEnv ?? "HWM_TEST_CONFIG")}`,
    `dependencies = ${JSON.stringify(options.dependencies ?? [])}`,
    "",
    "[environment]",
    `inherit = ${JSON.stringify(options.inherit ?? [])}`,
    "",
    "[environment.set]",
    assignments,
    "",
  ].join("\n");
}

async function makeWorkspace(f: Fixture, name: string, options: Parameters<typeof manifestText>[0] = { name }): Promise<string> {
  const directory = path.join(f.root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "harness.toml"), manifestText(options), "utf8");
  return directory;
}

async function register(f: Fixture, name: string, options: Parameters<typeof manifestText>[0] = { name }): Promise<string> {
  const workspace = await makeWorkspace(f, name, options);
  assert.equal(await f.run(["register", workspace]), 0, f.errors.join("\n"));
  f.output.length = 0;
  f.errors.length = 0;
  return workspace;
}

test("registers and looks up two Harnesses without copying workspace files", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const firstPath = await register(f, "coding");
  const secondPath = await register(f, "research");
  assert.equal(await f.run(["list"]), 0);
  assert.match(f.output.join("\n"), /coding/);
  assert.match(f.output.join("\n"), /research/);
  assert.equal(await f.run(["show", "coding"]), 0);
  assert.ok(f.output.join("\n").includes(firstPath));
  assert.equal(await f.run(["show", "research"]), 0);
  assert.ok(f.output.join("\n").includes(secondPath));
  assert.equal((await readFile(path.join(firstPath, "harness.toml"), "utf8")).includes("coding"), true);
});

test("rejects duplicate Harness names", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const first = await makeWorkspace(f, "first", { name: "duplicate" });
  const second = await makeWorkspace(f, "second", { name: "duplicate" });
  assert.equal(await f.run(["register", first]), 0);
  assert.equal(await f.run(["register", second]), 1, `${f.output.join("\n")}\n${f.errors.join("\n")}`);
  assert.match(f.errors.join("\n"), /already registered/);
  assert.equal((await new RegistryStore(f.home).load()).harnesses.length, 1);
  assert.equal(await readFile(path.join(f.home, "harnesses", "duplicate", "manifest.toml"), "utf8").then(() => true, () => false), false);
});

test("registers the checked-in example manifests by reference", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  for (const name of ["coding", "research", "writing"]) {
    const workspace = path.resolve("examples", name);
    const manifestPath = path.join(workspace, "harness.toml");
    const before = await readFile(manifestPath, "utf8");
    assert.equal(await f.run(["register", workspace]), 0, f.errors.join("\n"));
    const entry = (await new RegistryStore(f.home).load()).harnesses.find((item) => item.name === name);
    assert.equal(entry?.manifestPath, manifestPath);
    assert.equal(await readFile(manifestPath, "utf8"), before);
    f.output.length = 0;
    f.errors.length = 0;
  }
});

test("keeps each child environment and config directory independent", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const script = "require('node:fs').writeFileSync(process.env.HWM_TEST_OUT, JSON.stringify({ kind: process.env.HARNESS_KIND, claude: process.env.CLAUDE_CONFIG_DIR ?? null, codex: process.env.CODEX_HOME ?? null, inherited: process.env.HWM_TEST_INHERITED ?? null, secret: process.env.HWM_TEST_SECRET ?? null }))";
  const outA = path.join(f.root, "a.json");
  const outB = path.join(f.root, "b.json");
  await register(f, "alpha", { name: "alpha", configEnv: "CLAUDE_CONFIG_DIR", args: ["-e", script], inherit: ["HWM_TEST_INHERITED"], set: { HARNESS_KIND: "alpha", HWM_TEST_OUT: outA } });
  await register(f, "beta", { name: "beta", configEnv: "CODEX_HOME", args: ["-e", script], set: { HARNESS_KIND: "beta", HWM_TEST_OUT: outB } });
  const manifests = await new RegistryStore(f.home).manifests();
  assert.notEqual(manifests[0]!.configDirectory, manifests[1]!.configDirectory);

  assert.equal(await f.run(["open", "alpha", "--workspace", path.join(f.root, "alpha")]), 0, f.errors.join("\n"));
  assert.equal(await f.run(["open", "beta", "--workspace", path.join(f.root, "beta")]), 0, f.errors.join("\n"));
  const a = JSON.parse(await readFile(outA, "utf8")) as { kind: string; claude: string | null; codex: string | null; inherited: string | null; secret: string | null };
  const b = JSON.parse(await readFile(outB, "utf8")) as { kind: string; claude: string | null; codex: string | null; inherited: string | null; secret: string | null };
  assert.equal(a.kind, "alpha");
  assert.equal(b.kind, "beta");
  assert.equal(a.claude, manifests[0]!.configDirectory);
  assert.equal(a.codex, null);
  assert.equal(b.claude, null);
  assert.equal(b.codex, manifests[1]!.configDirectory);
  assert.equal(a.inherited, "explicitly-allowed");
  assert.equal(b.inherited, null);
  assert.equal(a.secret, null);
  assert.equal(b.secret, null);
});

test("reports malformed manifests without registering them", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const workspace = path.join(f.root, "broken");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "harness.toml"), "schema_version = 42\n", "utf8");
  assert.equal(await f.run(["register", workspace]), 1);
  assert.match(f.errors.join("\n"), /Unsupported schema_version/);
  assert.equal((await new RegistryStore(f.home).load()).harnesses.length, 0);
});

test("doctor reports a missing executable before launch", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const workspace = await makeWorkspace(f, "missing", { name: "missing", executable: "hwm-command-that-does-not-exist" });
  assert.equal(await f.run(["register", workspace]), 0);
  f.errors.length = 0;
  assert.equal(await f.run(["doctor", "missing"]), 1);
  assert.match(f.errors.join("\n"), /Executable not found/);
});

test("returns the Harness exit code and leaves the parent environment unchanged", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const before = { ...f.env };
  const workspace = await makeWorkspace(f, "exit", { name: "exit", args: ["-e", "process.exit(23)"] });
  assert.equal(await f.run(["register", workspace]), 0);
  assert.equal(await f.run(["open", "exit", "--workspace", workspace]), 23);
  assert.deepEqual(f.env, before);
});

test("unregistering one Harness preserves another Harness and its config data", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await register(f, "first");
  await register(f, "second");
  const second = (await new RegistryStore(f.home).manifests()).find((item) => item.name === "second")!;
  await mkdir(second.configDirectory, { recursive: true });
  await writeFile(path.join(second.configDirectory, "sentinel"), "preserved", "utf8");
  assert.equal(await f.run(["unregister", "first"]), 0);
  const remaining = await new RegistryStore(f.home).load();
  assert.deepEqual(remaining.harnesses.map((item) => item.name), ["second"]);
  assert.equal(await readFile(path.join(second.configDirectory, "sentinel"), "utf8"), "preserved");
});

test("rejects conflicting config roots and invalid environment names", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const first = await makeWorkspace(f, "one");
  const second = await makeWorkspace(f, "two", { name: "two", configDirectory: "profiles/one/config" });
  assert.equal(await f.run(["register", first]), 0);
  assert.equal(await f.run(["register", second]), 1);
  assert.match(f.errors.join("\n"), /already assigned/);

  const invalid = path.join(f.root, "invalid-env");
  await mkdir(invalid);
  await writeFile(path.join(invalid, "harness.toml"), manifestText({ name: "invalid", set: { HOME: "/tmp" } }), "utf8");
  f.errors.length = 0;
  assert.equal(await f.run(["register", invalid]), 1);
  assert.match(f.errors.join("\n"), /reserved/);
});

test("doctor rejects a config path redirected by a symlink", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const outside = path.join(f.root, "outside-config");
  const workspace = await makeWorkspace(f, "linked", { name: "linked", configDirectory: "profiles/linked/config" });
  await mkdir(path.join(f.home, "profiles"), { recursive: true });
  await mkdir(outside);
  await rm(path.join(f.home, "profiles"), { recursive: true, force: true });
  await symlink(outside, path.join(f.home, "profiles"), "dir");
  assert.equal(await f.run(["register", workspace]), 0);
  assert.equal(await f.run(["doctor", "linked"]), 1);
  assert.match(f.errors.join("\n"), /symbolic link/);
  assert.deepEqual(await readdir(outside), []);
});

test("NativeRuntimeAdapter forwards stop signals and records status", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const workspace = await makeWorkspace(f, "long", { name: "long", args: ["-e", "setInterval(() => {}, 1000)"] });
  assert.equal(await f.run(["register", workspace]), 0);
  const manifest = await loadManifest((await new RegistryStore(f.home).load()).harnesses[0]!.manifestPath, f.home);
  const runtime = new NativeRuntimeAdapter();
  const spec = await runtime.prepare(manifest, f.env);
  const started = runtime.start(spec);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(runtime.status().state, "running");
  await runtime.stop("SIGTERM");
  const result = await started;
  assert.equal(result.signal, "SIGTERM");
  assert.deepEqual(runtime.status(), { state: "stopped", result });
});
