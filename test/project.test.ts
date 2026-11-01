import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import TOML from "@iarna/toml";
import { runCli } from "../src/cli.js";
import { RegistryStore } from "../src/store.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hwm-project-"));
  const home = path.join(root, "manager");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH || "", HOME: path.join(root, "home"), LANG: "C" };
  await mkdir(env.HOME!, { recursive: true });
  const output: string[] = [];
  const errors: string[] = [];
  const run = (args: string[], cwd = root) => runCli(args, { home, env, cwd, stdout: (line) => output.push(line), stderr: (line) => errors.push(line) });

  async function harness(name: string, configEnv: string) {
    const source = path.join(root, "harnesses", name);
    const scripts = path.join(source, "scripts");
    await mkdir(scripts, { recursive: true });
    const observation = path.join(root, `${name}-observed.json`);
    const launcher = path.join(scripts, "launch");
    await writeFile(launcher, [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.HWM_TEST_OBSERVATION, JSON.stringify({ cwd: process.cwd(), harnessRoot: process.env.HWM_HARNESS_ROOT, projectRoot: process.env.HWM_PROJECT_ROOT, configRoot: process.env.CODEX_HOME ?? process.env.CLAUDE_CONFIG_DIR, name: process.env.HWM_TEST_NAME }));",
      "",
    ].join("\n"), { encoding: "utf8", mode: 0o700 });
    await chmod(launcher, 0o700);
    await writeFile(path.join(source, "harness.toml"), [
      "schema_version = 1",
      `name = ${JSON.stringify(name)}`,
      `description = ${JSON.stringify(name)}`,
      'harness_path = "."',
      'runtime_type = "native"',
      'executable = "./scripts/launch"',
      "args = []",
      `config_directory = ${JSON.stringify(`profiles/${name}/config`)}`,
      `config_env = ${JSON.stringify(configEnv)}`,
      "dependencies = []",
      "",
      "[environment]",
      'provider = "native"',
      "inherit = []",
      "",
      "[environment.set]",
      `HWM_TEST_NAME = ${JSON.stringify(name)}`,
      `HWM_TEST_OBSERVATION = ${JSON.stringify(observation)}`,
      "",
    ].join("\n"), "utf8");
    assert.equal(await run(["register", source]), 0, errors.join("\n"));
    errors.length = 0;
    return { source, observation };
  }

  return { root, home, env, output, errors, run, harness };
}

test("one Project links multiple Harnesses and runs each source script in the Project", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const coding = await f.harness("coding", "CODEX_HOME");
  const writing = await f.harness("writing", "CLAUDE_CONFIG_DIR");
  const project = path.join(f.root, "Desktop", "projects", "personal", "newproj");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "README.txt"), "project file", "utf8");

  assert.equal(await f.run(["project", "register", project, "--name", "newproj", "--harness", "coding", "--harness", "writing"]), 0, f.errors.join("\n"));
  assert.deepEqual((await new RegistryStore(f.home).load()).projects[0]?.harnesses, ["coding", "writing"]);
  assert.equal(await f.run(["project", "doctor", "newproj"]), 0, f.errors.join("\n"));
  assert.equal(await f.run(["open", "coding", "--project", "newproj"]), 0, f.errors.join("\n"));
  assert.equal(await f.run(["project", "open", "newproj", "--harness", "writing"]), 0, f.errors.join("\n"));
  const codingRun = JSON.parse(await readFile(coding.observation, "utf8")) as Record<string, string>;
  const writingRun = JSON.parse(await readFile(writing.observation, "utf8")) as Record<string, string>;
  assert.equal(codingRun.cwd, await realpath(project));
  assert.equal(writingRun.cwd, await realpath(project));
  assert.equal(codingRun.harnessRoot, await realpath(coding.source));
  assert.equal(writingRun.harnessRoot, await realpath(writing.source));
  assert.equal(codingRun.projectRoot, await realpath(project));
  assert.equal(writingRun.projectRoot, await realpath(project));
  assert.notEqual(codingRun.configRoot, writingRun.configRoot);
  assert.equal(await readFile(path.join(project, "README.txt"), "utf8"), "project file");
  assert.deepEqual(await readdir(project), ["README.txt"]);
});

test("start TUI registers the current folder, links a selected Harness, and launches it", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const coding = await f.harness("coding", "CODEX_HOME");
  const codexConfig = path.join(coding.source, ".codex", "config.toml");
  await mkdir(path.dirname(codexConfig));
  await writeFile(codexConfig, '[mcp_servers.rea]\ncommand = "npx"\n', "utf8");
  const skillPath = path.join(coding.source, "skills", "sample");
  await mkdir(skillPath, { recursive: true });
  await writeFile(path.join(skillPath, "SKILL.md"), "# Sample\n", "utf8");
  const codexLauncher = path.join(coding.source, "scripts", "codex");
  await writeFile(codexLauncher, [
    "#!/usr/bin/env node",
    "require('node:fs').writeFileSync(process.env.HWM_TEST_OBSERVATION, JSON.stringify({ cwd: process.cwd(), harnessRoot: process.env.HWM_HARNESS_ROOT, args: process.argv.slice(2) }))",
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o700 });
  await chmod(codexLauncher, 0o700);
  const manifestPath = path.join(coding.source, "harness.toml");
  await writeFile(manifestPath, (await readFile(manifestPath, "utf8")).replace('executable = "./scripts/launch"', 'executable = "./scripts/codex"'), "utf8");
  const project = path.join(f.root, "personal", "newproj");
  await mkdir(project, { recursive: true });
  const prompts: Array<{ title: string; choices: string[] }> = [];
  let prompt = 0;
  const code = await runCli(["start"], {
    home: f.home,
    cwd: project,
    env: f.env,
    stdout: (line) => f.output.push(line),
    stderr: (line) => f.errors.push(line),
    choose: async (title, choices) => {
      prompts.push({ title, choices });
      const selected = prompt++;
      if (selected === 0) return 0;
      if (title.startsWith("Choose a Harness")) return choices.findIndex((choice) => choice.startsWith("coding "));
      return 0;
    },
  });
  assert.equal(code, 0, f.errors.join("\n"));
  assert.equal(prompts.length, 3);
  const projectEntry = (await new RegistryStore(f.home).load()).projects[0]!;
  assert.equal(projectEntry.name, "newproj");
  assert.deepEqual(projectEntry.harnesses, ["coding"]);
  assert.deepEqual(projectEntry.sourceConfigHarnesses, ["coding"]);
  const observed = JSON.parse(await readFile(coding.observation, "utf8")) as { cwd: string; harnessRoot: string; args: string[] };
  assert.equal(observed.cwd, await realpath(project));
  assert.equal(observed.harnessRoot, await realpath(coding.source));
  assert.deepEqual(observed.args, ["--profile", "hwm-source"]);
  const generatedProfile = path.join(f.home, "profiles", "coding", "config", "hwm-source.config.toml");
  const profile = TOML.parse(await readFile(generatedProfile, "utf8")) as Record<string, unknown>;
  assert.equal((profile.mcp_servers as Record<string, Record<string, unknown>>).rea.command, "npx");
  assert.equal(((profile.skills as Record<string, unknown>).config as Array<Record<string, unknown>>)[0]!.path, await realpath(skillPath));
});

test("interactive harness registration stores only a manager-owned reference", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const source = path.join(f.root, "custom-writing-harness");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "asset.txt"), "source stays here", "utf8");
  const answers = [source, "writing"];
  const prompts: string[] = [];
  assert.equal(await runCli(["register"], {
    home: f.home,
    cwd: f.root,
    env: f.env,
    stdout: (line) => f.output.push(line),
    stderr: (line) => f.errors.push(line),
    ask: async (prompt) => { prompts.push(prompt); return answers.shift()!; },
  }), 0, f.errors.join("\n"));
  const manifest = (await new RegistryStore(f.home).manifests())[0]!;
  assert.equal(manifest.name, "writing");
  assert.equal(manifest.workspacePath, await realpath(source));
  assert.equal(manifest.manifestPath.startsWith(f.home), true);
  assert.equal(await readFile(path.join(source, "asset.txt"), "utf8"), "source stays here");
  assert.equal(await readdir(source).then((names) => names.includes("harness.toml")), false);
  assert.equal(prompts.length, 2);
});

test("start TUI can register the first Harness and initialize its first Project", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const harnessSource = path.join(f.root, "first-harness");
  const project = path.join(f.root, "personal", "first-project");
  await Promise.all([mkdir(harnessSource, { recursive: true }), mkdir(project, { recursive: true })]);
  const harnessManifest = [
    "schema_version = 1",
    'name = "first"',
    'description = "First Harness"',
    'harness_path = "."',
    'runtime_type = "native"',
    `executable = ${JSON.stringify(process.execPath)}`,
    `args = ${JSON.stringify(["-e", "process.exit(0)"])}`,
    'config_directory = "profiles/first/config"',
    'config_env = "HWM_TEST_CONFIG"',
    "dependencies = []",
    "",
    "[environment]",
    'provider = "native"',
    "inherit = []",
    "",
    "[environment.set]",
    "",
  ].join("\n");
  await writeFile(path.join(harnessSource, "harness.toml"), harnessManifest, "utf8");
  const asked: string[] = [];
  const code = await runCli(["start"], {
    home: f.home,
    cwd: project,
    env: f.env,
    stdout: (line) => f.output.push(line),
    stderr: (line) => f.errors.push(line),
    ask: async (prompt) => { asked.push(prompt); return harnessSource; },
    choose: async (_title, choices) => {
      assert.ok(choices.length > 0);
      return 0;
    },
  });
  assert.equal(code, 0, f.errors.join("\n"));
  assert.equal(asked.length, 1);
  const registry = await new RegistryStore(f.home).load();
  assert.equal(registry.harnesses[0]?.name, "first");
  assert.deepEqual(registry.projects[0]?.harnesses, ["first"]);
  assert.equal(await readFile(path.join(harnessSource, "harness.toml"), "utf8"), harnessManifest);
  assert.equal(f.errors.length, 0);
});

test("the same Harness works from linked Projects in different directories", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const coding = await f.harness("coding", "CODEX_HOME");
  const first = path.join(f.root, "Desktop", "projects", "personal", "first");
  const second = path.join(f.root, "Volumes", "work", "second");
  await Promise.all([mkdir(first, { recursive: true }), mkdir(second, { recursive: true })]);
  assert.equal(await f.run(["project", "register", first, "--name", "first", "--harness", "coding"]), 0);
  assert.equal(await f.run(["project", "register", second, "--name", "second", "--harness", "coding"]), 0);
  assert.equal(await f.run(["open", "coding"], first), 0, f.errors.join("\n"));
  const firstRun = JSON.parse(await readFile(coding.observation, "utf8")) as Record<string, string>;
  assert.equal(firstRun.cwd, await realpath(first));
  const nested = path.join(second, "src");
  await mkdir(nested);
  await promisify(execFile)(process.execPath, [path.resolve("dist/src/cli.js"), "open", "coding"], {
    cwd: nested,
    env: { ...f.env, HWM_HOME: f.home },
    encoding: "utf8",
  });
  const secondRun = JSON.parse(await readFile(coding.observation, "utf8")) as Record<string, string>;
  assert.equal(secondRun.cwd, await realpath(second));
  assert.equal(firstRun.configRoot, secondRun.configRoot);
  assert.equal(secondRun.harnessRoot, await realpath(coding.source));

  const launcher = path.join(coding.source, "scripts", "launch");
  await writeFile(launcher, `${await readFile(launcher, "utf8")}\nconst updated = JSON.parse(fs.readFileSync(process.env.HWM_TEST_OBSERVATION, 'utf8')); updated.revision = 2; fs.writeFileSync(process.env.HWM_TEST_OBSERVATION, JSON.stringify(updated));\n`, "utf8");
  assert.equal(await f.run(["open", "coding", "--project", "first"]), 0);
  const updatedRun = JSON.parse(await readFile(coding.observation, "utf8")) as Record<string, string | number>;
  assert.equal(updatedRun.revision, 2);
  assert.equal(updatedRun.configRoot, firstRun.configRoot);
});

test("doctor fails when a Harness source's project config would not load in another Project", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const coding = await f.harness("coding", "CODEX_HOME");
  await mkdir(path.join(coding.source, ".codex"));
  await writeFile(path.join(coding.source, ".codex", "config.toml"), "[mcp_servers.example]\ncommand = 'example'\n", "utf8");
  const executable = path.join(coding.source, "scripts", "codex");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o700 });
  await chmod(executable, 0o700);
  const manifestPath = path.join(coding.source, "harness.toml");
  await writeFile(manifestPath, (await readFile(manifestPath, "utf8")).replace('executable = "./scripts/launch"', 'executable = "./scripts/codex"'), "utf8");
  const project = path.join(f.root, "newproj");
  await mkdir(project);
  assert.equal(await f.run(["project", "register", project, "--harness", "coding"]), 0);
  assert.equal(await f.run(["doctor", "coding", "--project", "newproj"]), 1);
  assert.match(f.errors.join("\n"), /not loaded from/);
});

test("explicit Project activation loads selected Codex source config and skills without changing the Harness", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const coding = await f.harness("coding", "CODEX_HOME");
  const sourceConfig = path.join(coding.source, ".codex", "config.toml");
  await mkdir(path.dirname(sourceConfig));
  await writeFile(sourceConfig, '[mcp_servers.rea]\ncommand = "npx"\nargs = ["rea", "mcp"]\n', "utf8");
  const skill = path.join(coding.source, "skills", "sample");
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "# Sample skill\n", "utf8");
  const launcher = path.join(coding.source, "scripts", "codex");
  await writeFile(launcher, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.HWM_TEST_OBSERVATION, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), profile: process.env.CODEX_HOME, harnessRoot: process.env.HWM_HARNESS_ROOT }));",
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o700 });
  await chmod(launcher, 0o700);
  const manifestPath = path.join(coding.source, "harness.toml");
  await writeFile(manifestPath, (await readFile(manifestPath, "utf8")).replace('executable = "./scripts/launch"', 'executable = "./scripts/codex"'), "utf8");
  const project = path.join(f.root, "newproj");
  await mkdir(project);

  assert.equal(await f.run(["project", "register", project, "--harness", "coding", "--use-harness-config", "coding"]), 0, f.errors.join("\n"));
  assert.equal(await f.run(["project", "doctor", "newproj"]), 0, f.errors.join("\n"));
  assert.equal(await f.run(["project", "open", "newproj", "--harness", "coding"]), 0, f.errors.join("\n"));
  const observed = JSON.parse(await readFile(coding.observation, "utf8")) as { cwd: string; args: string[]; profile: string; harnessRoot: string };
  assert.equal(observed.cwd, await realpath(project));
  assert.deepEqual(observed.args, ["--profile", "hwm-source"]);
  assert.equal(observed.harnessRoot, await realpath(coding.source));
  const generated = path.join(observed.profile, "hwm-source.config.toml");
  const profile = TOML.parse(await readFile(generated, "utf8")) as Record<string, unknown>;
  assert.equal((profile.mcp_servers as Record<string, Record<string, unknown>>).rea.command, "npx");
  assert.equal(((profile.skills as Record<string, unknown>).config as Array<Record<string, unknown>>)[0]!.path, await realpath(skill));
  assert.equal(await readFile(sourceConfig, "utf8"), '[mcp_servers.rea]\ncommand = "npx"\nargs = ["rea", "mcp"]\n');

  await writeFile(sourceConfig, '[mcp_servers.rea]\ncommand = "updated-tool"\n', "utf8");
  assert.equal(await f.run(["open", "coding", "--project", "newproj"]), 0);
  const refreshed = TOML.parse(await readFile(generated, "utf8")) as Record<string, unknown>;
  assert.equal((refreshed.mcp_servers as Record<string, Record<string, unknown>>).rea.command, "updated-tool");
  assert.equal(await f.run(["project", "deactivate", "newproj", "coding"]), 0);
  assert.equal(await f.run(["project", "doctor", "newproj"]), 1);
});

test("source config activation refuses permission and provider settings", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const coding = await f.harness("coding", "CODEX_HOME");
  const sourceConfig = path.join(coding.source, ".codex", "config.toml");
  await mkdir(path.dirname(sourceConfig));
  await writeFile(sourceConfig, 'sandbox_mode = "danger-full-access"\n', "utf8");
  const launcher = path.join(coding.source, "scripts", "codex");
  await writeFile(launcher, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o700 });
  await chmod(launcher, 0o700);
  const manifestPath = path.join(coding.source, "harness.toml");
  await writeFile(manifestPath, (await readFile(manifestPath, "utf8")).replace('executable = "./scripts/launch"', 'executable = "./scripts/codex"'), "utf8");
  const project = path.join(f.root, "newproj");
  await mkdir(project);
  assert.equal(await f.run(["project", "register", project, "--harness", "coding", "--use-harness-config", "coding"]), 1);
  assert.match(f.errors.join("\n"), /cannot be promoted to a user profile: sandbox_mode/);
  assert.equal((await new RegistryStore(f.home).load()).projects.length, 0);
});

test("Project links are validated and legacy registries remain readable", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await mkdir(f.home, { recursive: true });
  await writeFile(path.join(f.home, "registry.json"), '{"version":1,"harnesses":[]}\n', "utf8");
  assert.deepEqual((await new RegistryStore(f.home).load()).projects, []);
  const coding = await f.harness("coding", "CODEX_HOME");
  const project = path.join(f.root, "client");
  await mkdir(project);
  assert.equal(await f.run(["project", "register", project, "--name", "client", "--harness", "coding"]), 0);
  assert.equal(await f.run(["project", "attach", "client", "missing"]), 1);
  assert.match(f.errors.join("\n"), /not registered/);
  f.errors.length = 0;
  assert.equal(await f.run(["open", "missing", "--project", "client"]), 1);
  assert.equal(await f.run(["unregister", "coding"]), 1);
  assert.match(f.errors.join("\n"), /detach it first/);
  f.errors.length = 0;
  assert.equal(await f.run(["project", "detach", "client", "coding"]), 0);
  assert.equal(await f.run(["open", "coding", "--project", "client"]), 1);
  assert.match(f.errors.join("\n"), /not attached/);
  assert.equal(await readFile(path.join(coding.source, "harness.toml"), "utf8").then(() => true), true);
});
