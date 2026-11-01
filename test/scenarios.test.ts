import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RegistryStore } from "../src/store.js";
import { runCli } from "../src/cli.js";

interface ScenarioFixture {
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
  output: string[];
  errors: string[];
  run(args: string[]): Promise<number>;
  workspace(name: string, options?: WorkspaceOptions): Promise<string>;
}

interface WorkspaceOptions {
  marker?: string;
  setting?: string;
  wait?: boolean;
  stopFile?: string;
  exitCode?: number;
  executable?: string;
  args?: string[];
}

interface Observation {
  name: string;
  cwd: string;
  config: string;
  settingBefore: string | null;
  skill: string;
  hook: string;
  pid: number;
}

async function fixture(): Promise<ScenarioFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hwm-scenarios-"));
  const home = path.join(root, "manager");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || "",
    HOME: path.join(root, "host-home"),
    LANG: "C",
  };
  await mkdir(env.HOME!, { recursive: true });
  const output: string[] = [];
  const errors: string[] = [];
  return {
    root, home, env, output, errors,
    run: (args) => runCli(args, { home, cwd: root, env, stdout: (text) => output.push(text), stderr: (text) => errors.push(text) }),
    async workspace(name, options = {}) {
      const workspace = path.join(root, name);
      await mkdir(path.join(workspace, "skills"), { recursive: true });
      await mkdir(path.join(workspace, "hooks"), { recursive: true });
      await writeFile(path.join(workspace, "skills", "identity.md"), `${options.marker ?? name}-skill`, "utf8");
      await writeFile(path.join(workspace, "hooks", "identity.txt"), `${options.marker ?? name}-hook`, "utf8");
      const outputPath = path.join(root, `${name}-observation.json`);
      const settingPath = `path.join(config, "test-setting.json")`;
      const childScript = [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const config = process.env.HWM_TEST_CONFIG;",
        `const settingPath = ${settingPath};`,
        "const settingBefore = fs.existsSync(settingPath) ? JSON.parse(fs.readFileSync(settingPath, 'utf8')).value : null;",
        "if (process.env.HWM_WRITE_SETTING) fs.writeFileSync(settingPath, JSON.stringify({ owner: process.env.HARNESS_NAME, value: process.env.HWM_WRITE_SETTING }));",
        "fs.writeFileSync(path.join(config, 'session.json'), JSON.stringify({ owner: process.env.HARNESS_NAME, pid: process.pid }));",
        "const observation = { name: process.env.HARNESS_NAME, cwd: process.cwd(), config, settingBefore, skill: fs.readFileSync(path.join(process.cwd(), 'skills', 'identity.md'), 'utf8'), hook: fs.readFileSync(path.join(process.cwd(), 'hooks', 'identity.txt'), 'utf8'), pid: process.pid };",
        "fs.writeFileSync(process.env.HWM_OBSERVATION, JSON.stringify(observation));",
        "if (process.env.HWM_WAIT === '1') { const timer = setInterval(() => { if (fs.existsSync(process.env.HWM_STOP_FILE)) { clearInterval(timer); process.exit(0); } }, 15); }",
        "else if (process.env.HWM_EXIT_CODE) process.exit(Number(process.env.HWM_EXIT_CODE));",
      ].join("\n");
      const manifest = [
        "schema_version = 1",
        `name = ${JSON.stringify(name)}`,
        `description = ${JSON.stringify(`Scenario ${name}`)}`,
        'workspace_path = "."',
        'runtime_type = "native"',
        `executable = ${JSON.stringify(options.executable ?? process.execPath)}`,
        `args = ${JSON.stringify(options.args ?? ["-e", childScript])}`,
        `config_directory = ${JSON.stringify(`profiles/${name}/config`)}`,
        'config_env = "HWM_TEST_CONFIG"',
        "dependencies = []",
        "",
        "[environment]",
        'provider = "native"',
        "inherit = []",
        "",
        "[environment.set]",
        `HARNESS_NAME = ${JSON.stringify(name)}`,
        `HWM_OBSERVATION = ${JSON.stringify(outputPath)}`,
        `HWM_WRITE_SETTING = ${JSON.stringify(options.setting ?? "")}`,
        `HWM_WAIT = ${JSON.stringify(options.wait ? "1" : "0")}`,
        `HWM_STOP_FILE = ${JSON.stringify(options.stopFile ?? path.join(root, `${name}-stop`))}`,
        ...(options.exitCode === undefined ? [] : [`HWM_EXIT_CODE = ${JSON.stringify(String(options.exitCode))}`]),
        "",
      ].join("\n");
      await writeFile(path.join(workspace, "harness.toml"), manifest, "utf8");
      return workspace;
    },
  };
}

async function register(f: ScenarioFixture, workspace: string): Promise<void> {
  assert.equal(await f.run(["register", workspace]), 0, f.errors.join("\n"));
  f.errors.length = 0;
  f.output.length = 0;
}

async function observe(f: ScenarioFixture, name: string): Promise<Observation> {
  return JSON.parse(await readFile(path.join(f.root, `${name}-observation.json`), "utf8")) as Observation;
}

function cliProcess(f: ScenarioFixture, name: string): ChildProcess {
  const cliPath = path.resolve("dist/src/cli.js");
  return spawn(process.execPath, [cliPath, "open", name, "--workspace", path.join(f.root, name)], {
    cwd: f.root,
    env: { ...process.env, HWM_HOME: f.home },
    stdio: "ignore",
  });
}

async function waitForFile(filePath: string, child: ChildProcess): Promise<void> {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    try { await access(filePath); return; }
    catch {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Harness process exited before creating ${path.basename(filePath)}.`);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  throw new Error(`Timed out waiting for ${path.basename(filePath)}.`);
}

function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
}

test("Scenario A/B: switching Harnesses isolates settings and preserves Skills/Hooks changes", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const coding = await f.workspace("coding", { marker: "coding-v1", setting: "coding-setting-v1" });
  const writing = await f.workspace("writing", { marker: "writing-v1" });
  await register(f, coding);
  await register(f, writing);

  assert.equal(await f.run(["open", "coding", "--workspace", coding]), 0, f.errors.join("\n"));
  const codingFirst = await observe(f, "coding");
  assert.equal(codingFirst.settingBefore, null);
  assert.equal(codingFirst.skill, "coding-v1-skill");
  assert.equal(codingFirst.hook, "coding-v1-hook");

  const manifests = await new RegistryStore(f.home).manifests();
  const codingConfig = manifests.find((item) => item.name === "coding")!.configDirectory;
  const writingConfig = manifests.find((item) => item.name === "writing")!.configDirectory;
  assert.notEqual(codingConfig, writingConfig);

  await writeFile(path.join(coding, "skills", "identity.md"), "coding-v2-skill", "utf8");
  await writeFile(path.join(coding, "hooks", "identity.txt"), "coding-v2-hook", "utf8");
  const writingSkillBefore = await readFile(path.join(writing, "skills", "identity.md"), "utf8");
  const writingHookBefore = await readFile(path.join(writing, "hooks", "identity.txt"), "utf8");

  assert.equal(await f.run(["open", "writing", "--workspace", writing]), 0, f.errors.join("\n"));
  const writingRun = await observe(f, "writing");
  assert.equal(writingRun.settingBefore, null);
  assert.equal(writingRun.skill, "writing-v1-skill");
  assert.equal(writingRun.hook, "writing-v1-hook");
  assert.equal(await readFile(path.join(writing, "skills", "identity.md"), "utf8"), writingSkillBefore);
  assert.equal(await readFile(path.join(writing, "hooks", "identity.txt"), "utf8"), writingHookBefore);
  await assert.rejects(readFile(path.join(writingConfig, "test-setting.json")), { code: "ENOENT" });

  assert.equal(await f.run(["open", "coding", "--workspace", coding]), 0, f.errors.join("\n"));
  const codingSecond = await observe(f, "coding");
  assert.equal(codingSecond.settingBefore, "coding-setting-v1");
  assert.equal(codingSecond.skill, "coding-v2-skill");
  assert.equal(codingSecond.hook, "coding-v2-hook");
  assert.equal(JSON.parse(await readFile(path.join(codingConfig, "test-setting.json"), "utf8")).owner, "coding");
});

test("Scenario C: concurrent Harness processes have separate config/env and stop independently", async (t) => {
  const f = await fixture();
  const processes: ChildProcess[] = [];
  t.after(async () => {
    for (const child of processes) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited(child);
    }
    await rm(f.root, { recursive: true, force: true });
  });
  const codingStop = path.join(f.root, "coding-stop");
  const writingStop = path.join(f.root, "writing-stop");
  const coding = await f.workspace("coding", { marker: "coding-concurrent", wait: true, stopFile: codingStop });
  const writing = await f.workspace("writing", { marker: "writing-concurrent", wait: true, stopFile: writingStop });
  await register(f, coding);
  await register(f, writing);

  const codingProcess = cliProcess(f, "coding");
  processes.push(codingProcess);
  const writingProcess = cliProcess(f, "writing");
  processes.push(writingProcess);
  await Promise.all([
    waitForFile(path.join(f.root, "coding-observation.json"), codingProcess),
    waitForFile(path.join(f.root, "writing-observation.json"), writingProcess),
  ]);

  const codingState = await observe(f, "coding");
  const writingState = await observe(f, "writing");
  assert.notEqual(codingState.pid, writingState.pid);
  assert.notEqual(codingState.config, writingState.config);
  assert.equal(codingState.name, "coding");
  assert.equal(writingState.name, "writing");
  assert.equal(codingState.skill, "coding-concurrent-skill");
  assert.equal(writingState.skill, "writing-concurrent-skill");

  const codingExit = exited(codingProcess);
  codingProcess.kill("SIGTERM");
  const ended = await codingExit;
  assert.equal(ended.code, 143);
  assert.equal(writingProcess.exitCode, null);
  assert.equal(writingProcess.signalCode, null);
  await access(path.join(f.root, "writing-observation.json"));

  await writeFile(writingStop, "stop", "utf8");
  const writingEnded = await exited(writingProcess);
  assert.equal(writingEnded.code, 0);
});

test("Scenario D: registration, validation and abnormal exits recover without cross-Harness cleanup", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));

  assert.equal(await f.run(["open", "missing"]), 1);
  assert.match(f.errors.join("\n"), /not registered/);
  f.errors.length = 0;

  const malformed = path.join(f.root, "malformed");
  await mkdir(malformed);
  await writeFile(path.join(malformed, "harness.toml"), "schema_version = 99\n", "utf8");
  assert.equal(await f.run(["register", malformed]), 1);
  assert.match(f.errors.join("\n"), /Unsupported schema_version/);
  assert.equal((await new RegistryStore(f.home).load()).harnesses.length, 0);
  f.errors.length = 0;

  const broken = await f.workspace("broken", { executable: "hwm-no-such-executable" });
  await register(f, broken);
  const brokenManifest = (await new RegistryStore(f.home).manifests()).find((item) => item.name === "broken")!;
  assert.equal(await f.run(["doctor", "broken"]), 1);
  assert.match(f.errors.join("\n"), /Executable not found/);
  await assert.rejects(access(brokenManifest.configDirectory));
  f.errors.length = 0;

  const badExit = await f.workspace("bad-exit", { exitCode: 37 });
  await register(f, badExit);
  const badExitManifest = (await new RegistryStore(f.home).manifests()).find((item) => item.name === "bad-exit")!;
  assert.equal(await f.run(["open", "bad-exit", "--workspace", badExit]), 37);
  assert.equal(await readFile(path.join(badExitManifest.configDirectory, "session.json"), "utf8").then(() => true, () => false), true);
  const retained = await new RegistryStore(f.home).manifests();
  assert.ok(retained.some((item) => item.name === "broken"));
  assert.ok(retained.some((item) => item.name === "bad-exit"));
});
