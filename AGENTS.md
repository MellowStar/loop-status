# AGENTS.md

Instructions for coding agents. There are two cases: setting loop-status up in a project, and changing this package.

## Setting it up in a project

Follow `template/AGENTS.md`. In short:
- run `npx loop-status@<version> init`,
- point `loop.script` at the project's loop,
- copy the theme from the design doc,
- source `status-hooks.sh` and call `status` at each step,
- run `doctor`.

**Ask the owner before you run a loop:** `run` starts real, paid agent runs.

## Changing this package

- **Layout:**
  - `src/schema.mjs`: the dependency-free JSON Schema subset.
  - `src/config.mjs`: validation and defaults.
  - `src/status.mjs`: the status writer and reader.
  - `src/logs.mjs`: log listing, summaries and safe paths.
  - `src/server.mjs`: the page server.
  - `src/run.mjs`: the loop runner.
  - `src/cli.mjs`: the commands.
  - `web/index.html`: the page.
- **The files are the contract.** A field change touches `schema/status.schema.json`, `src/status.mjs`,
  `template/status-hooks.sh` (keep the two writers identical; a test checks it), `template/AGENTS.md`, the README and
  the sample outputs.
- **Keep the safety properties, each of which has a test:**
  - loopback bind,
  - the Host check,
  - GET only,
  - no write or run route,
  - text-only rendering (no HTML-parsing APIs in `web/index.html`),
  - log paths confined to `logsDir`,
  - status files never served as logs.
- No runtime dependencies. Node 24+.
- Run `npm test` before every commit. Regenerate `template/.build-logs` (see the README) when the writer or the sample
  loop changes.
