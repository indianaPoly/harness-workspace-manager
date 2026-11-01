# ADR 0002: mise prepares environments for the native runtime

- Status: Accepted
- Date: 2026-10-24

## Context

Harness sources need separate tool versions and environment variables. mise selects tools in `mise.toml`, puts resolved versions on `PATH`, and applies its config trust policy. The native process runner manages the child lifecycle. Using mise as another runtime would duplicate that role.

## Decision

- Keep `runtime_type = "native"` and add `environment.provider = "native" | "mise"`.
- `NativeEnvironmentProvider` builds the child environment from the manager's baseline, explicit inherited names, manifest values, and the Harness config-directory selector.
- `MiseEnvironmentProvider` runs mise directly with argument arrays and no shell. It evaluates the Harness source's `mise.toml` with `mise env --json`, then checks local requested tool versions with `mise ls --local --current --missing`.
- Add the Harness source parent to `MISE_CEILING_PATHS` without removing existing user ceilings. Pass through explicit host mise data and trust-policy variables, but remove `MISE_YES`; force automatic installation off for provider subprocesses.
- Do not call `mise trust`, `mise install`, `mise exec`, `mise use`, shell activation, or an installer. On a trust failure, stop and explain how to approve the reviewed file. If versions are missing, stop and instruct the user to run `mise install`.
- Do not print `mise env --json` output or raw mise stderr. Diagnostics contain paths and variable names only.
- Remove all `MISE_*` variables from the final Harness child environment. Reject provider output that tries to replace `HOME`, the manager root, or a Harness config selector.
- Keep Harness `dependencies` checks against the resolved child PATH, so a tool can be provided by mise or the host as declared.

## Consequences

- Different Harness manifests resolve their own versions per invocation; no shell PATH activation or process-global environment mutation is needed.
- mise-managed versions live in mise's own data store and are not installed into the existing global Node/Python/CLI locations. The manager does not install versions automatically.
- mise remains a required external tool only for Harnesses that select `environment.provider = "mise"`. Native Harnesses remain usable without it.
- mise's own global settings and trust policy remain in effect. The manager narrows project config discovery to the Harness source boundary, does not approve files, and does not print environment values.
- In the current machine, mise is not installed, so real mise execution cannot be verified here; provider behavior is tested with a synthetic executable.

## Rejected alternatives

- Treating mise as a Runtime Adapter: it resolves environment variables and PATH but does not replace the manager's process lifecycle contract.
- `mise exec` as the launcher: it may install missing tool versions and automatically trust active config in normal mode; the provider should resolve an environment while preserving the explicit Native Runtime and trust boundary.
- Running `mise activate` or editing shell startup files: this changes the user's shell environment and can mix workspaces after `cd`.

## Verification

Automated tests use a synthetic `mise` command to validate per-Workspace environment output, missing versions, trust refusal, no auto-install, parent environment immutability, Native-only operation, and repeat-run config preservation. Real mise integration remains untested on this host because `mise` is absent.
