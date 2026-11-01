import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadManifest, ManifestError } from "../src/manifest.js";

const base = (workspacePath: string, configDirectory = "profiles/sample/config") => `
schema_version = 1
name = "sample"
description = "Test manifest"
workspace_path = ${JSON.stringify(workspacePath)}
runtime_type = "native"
executable = "node"
args = []
config_directory = ${JSON.stringify(configDirectory)}
config_env = "CLAUDE_CONFIG_DIR"
dependencies = []

[environment]
inherit = []

[environment.set]
`;

test("resolves workspace paths from the manifest and config paths from manager home", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hwm-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const managerHome = path.join(root, "manager");
  await Promise.all([mkdir(workspace), mkdir(managerHome)]);
  const manifestPath = path.join(workspace, "harness.toml");
  await writeFile(manifestPath, base("."), "utf8");
  const manifest = await loadManifest(manifestPath, managerHome);
  assert.equal(manifest.workspacePath, workspace);
  assert.equal(manifest.configDirectory, path.join(managerHome, "profiles", "sample", "config"));
});

test("rejects config paths outside manager data and reserved environment overrides", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hwm-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const managerHome = path.join(root, "manager");
  await Promise.all([mkdir(workspace), mkdir(managerHome)]);
  const manifestPath = path.join(workspace, "harness.toml");

  await writeFile(manifestPath, base(".", "../../outside"), "utf8");
  await assert.rejects(loadManifest(manifestPath, managerHome), /config_directory must resolve inside/);

  await writeFile(manifestPath, `${base(".")}HOME = "/tmp"\n`, "utf8");
  await assert.rejects(loadManifest(manifestPath, managerHome), /reserved/);
});

test("does not echo malformed manifest contents in parse errors", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hwm-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const secretLike = "synthetic-secret-not-for-output";
  const manifestPath = path.join(workspace, "harness.toml");
  await writeFile(manifestPath, `schema_version = 1\n${secretLike}\n`, "utf8");
  await assert.rejects(loadManifest(manifestPath, root), (error: unknown) => {
    assert.ok(error instanceof ManifestError);
    assert.equal(error.message.includes(secretLike), false);
    return true;
  });
});
