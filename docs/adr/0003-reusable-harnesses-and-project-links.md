# ADR 0003: Reusable Harnesses and many-to-many Project links

- Status: Accepted
- Date: 2026-10-25

## Context

The first MVP used one `workspace_path` for the Harness source and the Project. As a result, `harness open coding` started in the `codex-harness` source repository even when the user wanted another Project. A Project must support several Harnesses. A Harness must work in several Projects.

## Decision

- Registry entries for Harnesses continue to reference their source folder and manifest. The new `harness_path` field names this role; older `workspace_path` manifests are read as Harness source paths.
- Store Project entries separately as `{name, path, harnesses[]}` in the manager-owned registry. Project registration and attachment do not write to the Project or Harness source.
- `project register --harness` can attach several Harnesses during initial setup. `project attach` and `project detach` update that list later.
- `open <harness> --project <project>` and `project open <project> --harness <harness>` choose a saved link. `--workspace <path>` provides a one-off target. An unqualified `open` resolves the registered Project containing the caller's current directory; otherwise it returns an actionable error.
- The runtime starts the Harness executable with the selected Project as `cwd`. `HWM_HARNESS_ROOT` points to the Harness source. `HWM_PROJECT_ROOT` points to the selected Project. The executable path can be relative to the Harness source, so a Harness can provide its own launcher.
- Config/session roots remain per Harness, so the same Harness can serve several Projects without changing its profile path. A Project can select different Harnesses without merging their config directories.
- Keep existing registry JSON and manifests readable. Missing `projects` means an empty Project list; registered Harness paths and profiles remain intact.
- The manager does not automatically execute arbitrary install scripts or promote project-scoped `.codex/config.toml` or `.claude/settings.json` files from a Harness source to user-level config. When running a bare Codex/Claude executable against another Project, Project-targeted `doctor` fails and explicit `open` warns about those source-scoped files.
- A Project and Codex Harness link can activate source configuration explicitly. The manager generates `$CODEX_HOME/hwm-source.config.toml` from the allowed MCP, skills, hooks, agents, and plugins sections. It selects that file with `--profile hwm-source`. It excludes authentication, provider, sandbox, and approval settings. It reads the unchanged source files on each launch. Users must review a Harness before activation because MCP and hook declarations can run commands.

## Consequences

- Working from `/some/newproj` with a linked `coding` Harness now starts its executable in `newproj`, while retaining the Coding profile and script root.
- Existing Harnesses that rely on source-local agent configuration need an explicit launcher/profile for complete activation in unrelated Projects. Registration alone does not imply their source-local files are loaded by an agent CLI.
- Native process permissions and the agent CLI's own project trust/sandbox rules continue to govern access to Project files.
- Project links are local manager metadata, so cloning a Project on another machine does not automatically transfer associations.

## Verification

Synthetic Harness launchers are executed from two unrelated Project directories. Tests verify multiple Harnesses attached to one Project, one Harness reused across Projects, distinct config roots, automatic Project selection from a nested current directory, unattached Harness rejection, and backward-compatible registry loading. Explicit Codex source activation is tested with a synthetic Codex executable, generated profile content, skill path references, profile refresh after source changes, and rejection of permission/provider keys. The existing `codex-harness` source also passed a read-only profile projection and temporary Project doctor check.
