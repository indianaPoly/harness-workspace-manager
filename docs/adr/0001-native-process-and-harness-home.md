# ADR 0001: Native process runtime with per-Harness homes

- Status: Superseded for the Harness/Project relationship by ADR 0003; Native Runtime decision retained
- Date: 2026-10-24

## Context

The manager must register Harness workspaces by reference and launch each as an independent CLI process. It must not change the user's global agent settings. Claude Code uses `CLAUDE_CONFIG_DIR` for its config root. Codex uses `CODEX_HOME`. The host can run native processes. Docker is installed, but its daemon is not running.

## Decision

- Use Node.js and TypeScript for a local foreground CLI. Start child programs with `spawn`, argument arrays, and `shell: false`.
- Store registry metadata and generated manifests in a manager-owned data directory. If a workspace contains `harness.toml`, read it there. Do not copy, move, or rewrite it.
- Use TOML for declarative Harness manifests and a small TOML parser dependency. Keep the registry as atomic JSON so no serializer dependency is needed for internal bookkeeping.
- Require a unique manager-owned config directory for each Harness. Set the config environment variable selected by its manifest. Build each child environment from a minimal baseline, explicit inherited names, and declared values.
- Keep Harness CLI configuration, project instructions, skills, hooks, MCP definitions, and dependency policy in each Harness workspace. The manager resolves paths and launches; it does not merge Harness definitions.
- Keep persistent CLI configuration/session state between runs. `open` creates the config directory if absent; it does not create disposable runtime files. `unregister` removes only the registry entry and preserves the workspace, manifest, and state.
- Define the runtime adapter contract now, but ship only `NativeRuntimeAdapter`. Add another runtime only with a concrete need and its own integration tests.

## Consequences

- Each isolated Claude Code/Codex home starts independently and may require a separate sign-in. The manager never copies or prints credentials.
- The native process runs with the user's OS identity and still inherits the host filesystem permissions. `HOME` and `PATH` remain available; this is configuration/session isolation, not a security sandbox.
- Project-level configuration continues to load according to the Harness CLI's rules. Identical workspace paths can therefore share project instructions/files even while their user-level config and session roots differ.
- Dependency versions come from the host PATH in the MVP. `mise`, Docker, and Nix remain future integrations; they are not silently installed or invoked.
- Runtime stop/status is process-local. `open` is a foreground command; it is not a daemon or background process manager.

## Rejected alternatives

- Docker as the default runtime: it adds a daemon and host bind-mount policy without being necessary for switching CLI settings and session state. It is a follow-on for untrusted code, reproducible Linux toolchains, or explicit filesystem/network isolation.
- Copying or installing an existing Harness during registration: it breaks the reference-only requirement and risks global settings changes.
- A database or service: the registry is small local metadata and atomic files are sufficient.
- A shell command string: shell parsing creates an avoidable injection boundary; commands and arguments remain separate values.

## Verification

`npm test` covers registry, manifest parsing, environment/config-root separation, command availability and exit handling, parent environment immutability, unregister preservation, and signal-driven child stop. No user credentials or session data are used.
