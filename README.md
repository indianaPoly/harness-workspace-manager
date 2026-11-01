# Harness Workspace Manager

[한국어](README.ko.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

A local CLI that connects reusable Harnesses to Projects. A Harness contains its scripts, configuration, and tools. A Project is the directory where you work. You can attach several Harnesses to one Project and use one Harness with several Projects.

## Requirements

- Node.js 22.18 or newer
- npm
- The executable named by each Harness manifest (for example, `codex`, `claude`, or a Harness-owned launcher script)

The manager uses TypeScript, Node's built-in test runner, and a TOML parser. It does not install global tools or edit shell startup files. It does not need a server or database.

## Install for development

```sh
npm install
npm run build
```

Run `npm run start -- list` or `node dist/src/cli.js list`. Neither command changes global commands or shell files.

## Quick start

```sh
cd /path/to/coding-harness
npm --prefix /path/to/harness-workspace-manager run start -- add
cd /path/to/writing-harness
npm --prefix /path/to/harness-workspace-manager run start -- add
cd /path/to/my-project
npm --prefix /path/to/harness-workspace-manager run start -- start
```

The registration menu asks for a Harness folder. If that folder has no `harness.toml`, it also asks for a name. The start menu lets you select the current folder as a Project and choose a Harness. The manager stores the link in its registry.

For non-interactive setup:

```sh
npm --prefix /path/to/harness-workspace-manager run start -- register /path/to/coding-harness --name coding
npm --prefix /path/to/harness-workspace-manager run start -- register /path/to/writing-harness --name writing
npm --prefix /path/to/harness-workspace-manager run start -- project register /path/to/my-project --name my-project --harness coding --harness writing --use-harness-config coding
npm --prefix /path/to/harness-workspace-manager run start -- project show my-project
npm --prefix /path/to/harness-workspace-manager run start -- project doctor my-project
npm --prefix /path/to/harness-workspace-manager run start -- project open my-project --harness coding
npm --prefix /path/to/harness-workspace-manager run start -- open writing --project my-project
```

Registration and attachment save references in the manager registry. They do not copy or change Harness or Project files. `open` starts the selected Harness executable in the **Project directory**. Each Harness keeps its own config and session directory.

From a registered Project, run `node /absolute/path/to/manager/dist/src/cli.js open coding` to select that Project automatically. You can also run `npm --prefix /absolute/path/to/manager run start -- start` from another directory. The Project picker uses the directory where you ran npm.

## Commands

```text
harness list
harness register [path] [--name NAME] [--description TEXT] [--executable COMMAND] [--config-env VARIABLE]
harness add
harness show <name>
harness unregister <name>
harness open <name> [--project NAME | --workspace PATH]
harness doctor <name> [--project NAME | --workspace PATH]
harness project register <path> [--name NAME] [--harness NAME ...]
harness project list
harness project show <name>
harness project doctor <name>
harness project attach <project> <harness> [--use-harness-config]
harness project activate <project> <harness>
harness project deactivate <project> <harness>
harness project detach <project> <harness>
harness project unregister <name>
harness project open <project> --harness <name>
harness start [harness-name]
harness --help
```

`register` stores the resolved path to a Harness source. If `<path>/harness.toml` exists, the manager reads it there. Otherwise, the manager creates a manifest in its own data directory. If it finds `.codex/config.toml`, it selects `codex` and `CODEX_HOME`. Otherwise, it selects `claude` and `CLAUDE_CONFIG_DIR`. Use flags to change the executable or config variable.

Repeat `--harness` with `project register` to attach several Harnesses. You can attach or detach more Harnesses later. To use `open --project`, first attach the Harness to that Project. Use `--workspace` to run in a directory without saving a link. An `open` command without a Project selects a registered, attached Project that contains the current directory. From the Harness source, it uses that source directory. From other directories, it explains how to select a Project. By default, `doctor` checks the Harness source. You can also use it to check a selected Project.
`--use-harness-config NAME` applies only to Codex during Project registration. For an existing link, use `project activate <project> <harness>` or `project deactivate ...`. Review the Harness source before you activate it. Its MCP servers and hooks can run commands. Activation applies to one Project and Harness link.

`project doctor` checks every attached Harness with the selected Project before the first run.

`start` opens a terminal menu where you select a Project and Harness with the arrow keys. It shows the current linked Project first. If the current folder is not registered, you can register it and attach the selected Harness. Use `start <harness>` to skip Harness selection. The menu asks about Codex source configuration only when it finds a config it can apply. In a non-interactive terminal, use `open` or `project open`. Use `register` without a path, or `add`, to open the Harness registration menu.

`unregister` keeps the Harness source folder, manifest, config, and sessions. Detach a Harness from every Project before you unregister it. Unregistering a Project keeps its files. The MVP has no purge command.

## Manifest

The optional `harness.toml` in each Harness source folder has these fields:

| Field | Meaning |
| --- | --- |
| `schema_version` | Required manifest version; currently `1`. |
| `name` | Unique lowercase registry name. |
| `description` | Human-readable purpose. |
| `harness_path` | Harness source root; relative paths resolve from the directory containing this manifest. Older `workspace_path` manifests remain supported. |
| `runtime_type` | `native` in the MVP. |
| `executable` | Bare command resolved from child `PATH`, or an executable path relative to the Harness source root. A Harness-owned launcher can use the environment variables below. |
| `args` | Argument array passed without a shell. |
| `config_directory` | Unique config/session root; relative paths resolve from the manager data directory and must remain inside it. |
| `config_env` | Environment variable receiving `config_directory`, such as `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. |
| `environment.inherit` | Additional parent environment variable names to pass to this Harness. Values are never printed. |
| `environment.set` | Child-only literal values or exact `${VARIABLE}` references. References are expanded without a shell. |
| `environment.provider` | `native` (default) or `mise`; `mise` reads `mise.toml` from the Harness source root. |
| `dependencies` | Executables that `doctor` must find on `PATH`. |

The child process receives absolute paths in `HWM_HARNESS_ROOT` and `HWM_PROJECT_ROOT`. It also inherits `PATH`, `HOME`, and basic locale, terminal, and temporary directory variables. Manifest values cannot replace paths or config variables that the manager controls. To pass other parent variables, list them in `environment.inherit` or reference them in `environment.set`.

Example manifests are in [`examples/coding/harness.toml`](examples/coding/harness.toml), [`examples/writing/harness.toml`](examples/writing/harness.toml), and [`examples/research/harness.toml`](examples/research/harness.toml). They are templates, not installed Harnesses. Register and inspect them with:

```sh
npm run start -- register ./examples/coding
npm run start -- register ./examples/writing
npm run start -- list
npm run start -- project register /path/to/real-project --name real-project --harness coding --harness writing --use-harness-config coding
npm run start -- doctor coding --project real-project
```

`coding` uses the Native environment provider and runs without mise. `writing` requires mise and declares Node 22 in `examples/writing/mise.toml`. Before you open `writing`, review its configuration. If mise asks you to trust it, approve the reviewed file. Then install the declared tool:

```sh
cd examples/writing
mise trust mise.toml   # only after reviewing the file, and only if mise requires trust
mise install
cd ../..
npm run start -- open writing --project real-project
```

The manager does not run `mise trust`, `mise install`, or an installer. It does not change mise's global config. From the Harness source, it runs `mise env --json` and checks for missing versions. It disables automatic installation for that invocation. It stops on mise trust errors and does not log the returned environment values. `doctor` evaluates mise configuration. A trusted `env._.source` script can run under mise's approval rules, so review the config before you approve it. The manager passes selected host `MISE_*` variables to mise to control trust and data paths. It removes those variables from the launched Harness environment. It also limits mise's config search to the Harness source boundary.

## State and isolation

The manager data root is:

- macOS: `~/Library/Application Support/Harness Workspace Manager`
- Windows: `%LOCALAPPDATA%\Harness Workspace Manager`
- Linux: `$XDG_DATA_HOME/harness-workspace-manager` or `~/.local/share/harness-workspace-manager`
- Any platform: set `HWM_HOME` before launching the manager to use a different root.

The registry is `registry.json`. Generated manifests are in `harnesses/<name>/`. Each manifest's `config_directory` specifies where config and sessions are stored. The registry also stores Project attachments. The manager uses `HWM_HOME` but does not pass it to the Harness process.

For each `open`, the manager creates a child environment without changing `process.env`. It removes inherited `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. It then sets the variable declared by the Harness to that Harness's config directory. The selected Project becomes the child working directory. This separates CLI config and local sessions when the CLI supports those variables. The child keeps the current `HOME` and `PATH`. It can access files available to the same OS user and load Project files under the agent CLI's own rules.

**Harness configuration:** The manager runs the declared executable or a launcher from the Harness source. It does not run `scripts/install.sh` during registration or attachment. When you work in another Project, the CLI does not automatically load `.codex/config.toml` or `.claude/settings.json` from the Harness source. A Project-targeted `doctor` check fails for a bare CLI until you handle that source configuration.

For Codex, use `--use-harness-config` on the link to apply selected source settings. The manager creates `$CODEX_HOME/hwm-source.config.toml` from the source's MCP, skills, hooks, agents, and plugins sections. It then launches Codex with `--profile hwm-source`. It does not include authentication, provider, sandbox, or approval settings. The source files stay unchanged. The profile updates when those files change. Project `.codex/` settings still follow Codex's trust rules. For Claude or custom setup, use a launcher in the Harness source. Relative paths in source configuration might need a launcher or absolute paths when you use another Project.

Do not put credentials in `harness.toml`. Use a reference such as `API_KEY = "${RESEARCH_API_KEY}"`. List a variable in `environment.inherit` only if the child also needs its original value. The manager does not print variable values or copy credentials between config roots. You might need to sign in once for each Harness.

`doctor` checks the manifest, paths, unique config roots, executables, dependencies, required environment references, and the selected Environment Provider. For mise, it checks that mise and `mise.toml` exist. It asks mise for the environment and reports missing versions without installing them. It does not run the Harness command. `open` repeats these checks before it starts the child with `shell: false`. It forwards terminal signals and returns the child's exit code. The child runs in the foreground and leaves no temporary runtime files to clean up.

Native execution separates configuration and sessions. It is not a security sandbox. Docker is a possible future option for untrusted code, reproducible Linux environments, or filesystem and network restrictions. A Docker runtime must mount only the selected workspace and config root. Writable bind mounts can change host files. On Windows, the manager rejects `.cmd` and `.bat` wrappers because it does not launch a shell. Use a native executable or `node.exe` with a JavaScript CLI entry point.

## Development

```sh
npm test
npm run build
```

Tests use temporary directories, a synthetic mise executable, and synthetic environment values. They do not use actual authentication, user config roots, saved sessions, or installed mise-managed versions.

Architecture decisions are recorded in [`docs/adr/0001-native-process-and-harness-home.md`](docs/adr/0001-native-process-and-harness-home.md).
The Harness/Project relationship is described in [`docs/adr/0003-reusable-harnesses-and-project-links.md`](docs/adr/0003-reusable-harnesses-and-project-links.md).
