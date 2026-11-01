import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadManifest } from "../src/manifest.js";
import { MiseEnvironmentProvider, NativeEnvironmentProvider } from "../src/environment.js";
import { NativeRuntimeAdapter } from "../src/runtime.js";
import { runCli } from "../src/cli.js";

interface EnvFixture {
  root: string;
  home: string;
  mise: string;
  log: string;
  env: NodeJS.ProcessEnv;
  workspace(name: string, version: string, marker: string): Promise<string>;
  manifest(workspace: string, name: string, provider?: "native" | "mise"): Promise<Awaited<ReturnType<typeof loadManifest>>>;
}

async function fixture(): Promise<EnvFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hwm-mise-test-"));
  const home = path.join(root, "manager");
  const bin = path.join(root, "fake-bin");
  await mkdir(bin, { recursive: true });
  const log = path.join(root, "mise-calls.jsonl");
  const mise = path.join(bin, "mise");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const cd = args.indexOf("--cd");
const workspace = args[cd + 1];
const command = args[cd + 2];
const source = fs.readFileSync(path.join(workspace, "mise.toml"), "utf8");
const version = /node\\s*=\\s*"([^"]+)"/.exec(source)?.[1] ?? "unspecified";
const marker = /WORKSPACE_MARKER\\s*=\\s*"([^"]+)"/.exec(source)?.[1] ?? path.basename(workspace);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, workspace, command, auto: process.env.MISE_AUTO_INSTALL, yes: process.env.MISE_YES, paranoid: process.env.MISE_PARANOID, trusted: process.env.MISE_TRUSTED_CONFIG_PATHS, ceilings: process.env.MISE_CEILING_PATHS, projectRoot: process.env.HWM_PROJECT_ROOT, harnessRoot: process.env.HWM_HARNESS_ROOT }) + "\\n");
if (path.basename(workspace) === "untrusted" && command === "env") {
  process.stderr.write("Config files in workspace/mise.toml are not trusted. Trust them with mise trust.");
  process.exit(1);
}
if (command === "ls") {
  if (version === "not-installed") process.stdout.write("node not-installed\\n");
  process.exit(0);
}
if (command === "env") {
  process.stdout.write(JSON.stringify({ PATH: path.join(workspace, "managed-bin") + path.delimiter + process.env.PATH, HWM_TEST_NODE_VERSION: version, HWM_TEST_WORKSPACE_MARKER: marker }));
  process.exit(0);
}
process.stderr.write("unexpected mise command");
process.exit(2);
`;
  await writeFile(mise, script, { encoding: "utf8", mode: 0o700 });
  await chmod(mise, 0o700);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || "",
    HOME: path.join(root, "host-home"),
    MISE_PARANOID: "1",
    MISE_TRUSTED_CONFIG_PATHS: "/approved/by/user",
    MISE_YES: "1",
  };
  await mkdir(env.HOME!, { recursive: true });
  return {
    root, home, mise, log, env,
    async workspace(name, version, marker) {
      const workspace = path.join(root, name);
      await mkdir(workspace, { recursive: true });
      await writeFile(path.join(workspace, "mise.toml"), `[tools]\nnode = ${JSON.stringify(version)}\n\n[env]\nWORKSPACE_MARKER = ${JSON.stringify(marker)}\n`, "utf8");
      return workspace;
    },
    async manifest(workspace, name, provider = "mise") {
      const manifestPath = path.join(workspace, "harness.toml");
      await writeFile(manifestPath, [
        "schema_version = 1",
        `name = ${JSON.stringify(name)}`,
        `description = ${JSON.stringify(name)}`,
        'workspace_path = "."',
        'runtime_type = "native"',
        'executable = "claude"',
        "args = []",
        `config_directory = ${JSON.stringify(`profiles/${name}/config`)}`,
        'config_env = "CLAUDE_CONFIG_DIR"',
        "dependencies = []",
        "",
        "[environment]",
        `provider = ${JSON.stringify(provider)}`,
        "inherit = []",
        "",
        "[environment.set]",
        "",
      ].join("\n"), "utf8");
      return loadManifest(manifestPath, home);
    },
  };
}

test("mise provider applies each Workspace's selected tools and environment only to that child", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const alphaRoot = await f.workspace("alpha", "22", "alpha-only");
  const betaRoot = await f.workspace("beta", "24", "beta-only");
  const alpha = await f.manifest(alphaRoot, "alpha");
  const beta = await f.manifest(betaRoot, "beta");
  const parentBefore = { ...f.env };
  const provider = new MiseEnvironmentProvider(f.mise);

  const alphaEnv = await provider.resolve(alpha, f.env);
  const betaEnv = await provider.resolve(beta, f.env);
  assert.equal(alphaEnv.env.HWM_TEST_NODE_VERSION, "22");
  assert.equal(alphaEnv.env.HWM_TEST_WORKSPACE_MARKER, "alpha-only");
  assert.ok(alphaEnv.env.PATH?.startsWith(path.join(alphaRoot, "managed-bin")));
  assert.equal(betaEnv.env.HWM_TEST_NODE_VERSION, "24");
  assert.equal(betaEnv.env.HWM_TEST_WORKSPACE_MARKER, "beta-only");
  assert.ok(betaEnv.env.PATH?.startsWith(path.join(betaRoot, "managed-bin")));
  assert.notEqual(alphaEnv.env.HWM_TEST_WORKSPACE_MARKER, betaEnv.env.HWM_TEST_WORKSPACE_MARKER);
  assert.equal(alphaEnv.env.MISE_PARANOID, undefined);
  assert.equal(alphaEnv.env.MISE_TRUSTED_CONFIG_PATHS, undefined);
  assert.deepEqual(f.env, parentBefore);

  const calls = (await readFile(f.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { workspace: string; command: string; auto: string; yes?: string; paranoid: string; trusted: string; ceilings: string });
  assert.equal(calls.filter((call) => call.workspace === alphaRoot && call.command === "env").length, 1);
  assert.equal(calls.filter((call) => call.workspace === betaRoot && call.command === "env").length, 1);
  assert.ok(calls.every((call) => call.auto === "0" && call.yes === undefined));
  assert.ok(calls.every((call) => call.paranoid === "1" && call.trusted === "/approved/by/user"));
  assert.ok(calls.every((call) => call.ceilings?.split(path.delimiter).includes(path.dirname(call.workspace))));
});

test("Native Runtime receives the selected mise environment and Harness config root", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const workspace = await f.workspace("runtime", "22", "runtime-only");
  const project = path.join(f.root, "target-project");
  await mkdir(project);
  const manifest = await f.manifest(workspace, "runtime");
  const observation = path.join(f.root, "child-env.json");
  const childManifest = {
    ...manifest,
    executable: process.execPath,
    args: ["-e", "require('node:fs').writeFileSync(process.env.HWM_TEST_OUT, JSON.stringify({ version: process.env.HWM_TEST_NODE_VERSION, marker: process.env.HWM_TEST_WORKSPACE_MARKER, config: process.env.CLAUDE_CONFIG_DIR, cwd: process.cwd(), projectRoot: process.env.HWM_PROJECT_ROOT, harnessRoot: process.env.HWM_HARNESS_ROOT }))"],
    environment: { ...manifest.environment, set: { ...manifest.environment.set, HWM_TEST_OUT: observation } },
  };
  const resolution = await new MiseEnvironmentProvider(f.mise).resolve(childManifest, f.env, project);
  assert.equal(resolution.diagnostics.some((item) => item.severity === "error"), false);
  const runtime = new NativeRuntimeAdapter();
  const spec = await runtime.prepare(childManifest, resolution.env, project);
  assert.equal((await runtime.start(spec)).code, 0);
  const observed = JSON.parse(await readFile(observation, "utf8")) as { version: string; marker: string; config: string; cwd: string; projectRoot: string; harnessRoot: string };
  assert.equal(observed.version, "22");
  assert.equal(observed.marker, "runtime-only");
  assert.equal(observed.config, childManifest.configDirectory);
  assert.equal(observed.cwd, await realpath(project));
  assert.equal(observed.projectRoot, project);
  assert.equal(observed.harnessRoot, workspace);
});

test("harness open wires the mise provider into the Native Runtime child", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const workspace = await f.workspace("cli-writing", "24", "cli-writing-only");
  await f.manifest(workspace, "cli-writing");
  const outputPath = path.join(f.root, "cli-open.json");
  const manifestPath = path.join(workspace, "harness.toml");
  const nodeScript = "require('node:fs').writeFileSync(process.env.HWM_TEST_OUT, JSON.stringify({ version: process.env.HWM_TEST_NODE_VERSION, marker: process.env.HWM_TEST_WORKSPACE_MARKER, config: process.env.CLAUDE_CONFIG_DIR }))";
  let source = await readFile(manifestPath, "utf8");
  source = source.replace('executable = "claude"', `executable = ${JSON.stringify(process.execPath)}`);
  source = source.replace("args = []", `args = ${JSON.stringify(["-e", nodeScript])}`);
  source += `HWM_TEST_OUT = ${JSON.stringify(outputPath)}\n`;
  await writeFile(manifestPath, source, "utf8");
  f.env.PATH = `${path.dirname(f.mise)}${path.delimiter}${f.env.PATH}`;
  const before = { ...f.env };
  const output: string[] = [];
  const errors: string[] = [];
  const code = await runCli(["register", workspace], { home: f.home, cwd: f.root, env: f.env, stdout: (line) => output.push(line), stderr: (line) => errors.push(line) });
  assert.equal(code, 0, errors.join("\n"));
  const openCode = await runCli(["open", "cli-writing", "--workspace", workspace], { home: f.home, cwd: f.root, env: f.env, stdout: (line) => output.push(line), stderr: (line) => errors.push(line) });
  assert.equal(openCode, 0, errors.join("\n"));
  assert.deepEqual(f.env, before);
  const observed = JSON.parse(await readFile(outputPath, "utf8")) as { version: string; marker: string; config: string };
  assert.equal(observed.version, "24");
  assert.equal(observed.marker, "cli-writing-only");
  assert.equal(observed.config, path.join(f.home, "profiles", "cli-writing", "config"));
});

test("mise checks missing tools without installing and keeps the Workspace config unchanged on rerun", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const workspace = await f.workspace("missing", "not-installed", "missing-only");
  const manifest = await f.manifest(workspace, "missing");
  const configPath = path.join(workspace, "mise.toml");
  const before = await readFile(configPath, "utf8");
  const provider = new MiseEnvironmentProvider(f.mise);

  const first = await provider.resolve(manifest, f.env);
  const second = await provider.resolve(manifest, f.env);
  assert.ok(first.diagnostics.some((item) => item.severity === "error" && item.message.includes("not installed")));
  assert.ok(first.diagnostics.some((item) => item.fix?.includes("mise install")));
  assert.equal(await readFile(configPath, "utf8"), before);
  await assert.rejects(stat(f.home), { code: "ENOENT" });
  assert.ok(second.diagnostics.some((item) => item.severity === "error"));
});

test("mise trust failures require the user to review and approve; manager never trusts or installs", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const workspace = await f.workspace("untrusted", "22", "untrusted-only");
  const manifest = await f.manifest(workspace, "untrusted");
  const result = await new MiseEnvironmentProvider(f.mise).resolve(manifest, f.env);
  assert.ok(result.diagnostics.some((item) => item.message.includes("untrusted config") && item.fix?.includes("mise trust")));
  const calls = (await readFile(f.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { command: string; args: string[] });
  assert.deepEqual(calls.map((call) => call.command), ["env"]);
  assert.ok(calls.every((call) => !call.args.includes("trust") && !call.args.includes("install") && !call.args.includes("--yes")));
});

test("mise requirement gives a clear missing-dependency error while native provider remains independent", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const workspace = await f.workspace("native", "22", "native-only");
  const native = await f.manifest(workspace, "native", "native");
  const nativeResult = await new NativeEnvironmentProvider().resolve(native, { HOME: f.env.HOME, PATH: f.env.PATH });
  assert.equal(nativeResult.diagnostics.some((item) => item.severity === "error"), false);
  assert.equal(nativeResult.env.CLAUDE_CONFIG_DIR, native.configDirectory);

  const miseManifest = await f.manifest(workspace, "needs-mise");
  const missing = await new MiseEnvironmentProvider(path.join(f.root, "no-mise" )).resolve(miseManifest, { HOME: f.env.HOME, PATH: "/usr/bin:/bin" });
  assert.ok(missing.diagnostics.some((item) => item.message.includes("requires mise") && item.fix?.includes("Install mise")));
});
