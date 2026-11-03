# loop-status

Run an agent build loop and watch it, per issue, on a local page. The page shows:

- each issue's state, step, run, PR, bundle, cost and turns;
- a timeline of every step;
- the build logs. Agent runs (`claude -p --output-format json`) are summarised as result, turns, cost and ok/error,
  and other logs are tailed.

It reads plain files your loop writes, so any loop in any language works. No runtime dependencies; Node 24+.

```bash
npx loop-status@0.1.0 init                     # config, status-hooks.sh and an agent guide
npx loop-status@0.1.0 run -- --once            # start the page, then run your loop with these args
open http://127.0.0.1:18092
```

## How it fits together

```
loop-status run -- <args>
  ├─ starts the page server if it isn't running (127.0.0.1:<port>)
  └─ runs loop.script <args>; its output also goes to <logsDir>/loop.log
        your loop ── source status-hooks.sh ──▶ <logsDir>/status/<issue>.json   (one file per issue)
                   └─ writes logs ─────────────▶ <logsDir>/<issue-43 | bundle-43-46>/...
page ◀── reads those files only
```

The contract is the files: `schema/status.schema.json` for the status files, plus the log layout below. `template/`
holds a working sample loop (`build-loop.sh`), the status writer (`status-hooks.sh`) and the outputs they produce
(`template/.build-logs/`). Agents adapting a project should read `template/AGENTS.md`.

## Commands

Run them from the repo root. `--config <file>` defaults to `./loop-status.config.json`, and the paths in the config are
relative to the repo root.

| Command | What it does |
| --- | --- |
| `run [-- <args>]` | Starts the page if needed, then runs `loop.script` with `loop.args` plus `<args>`, teeing its output to `<logsDir>/loop.log`. Refuses while another run is alive, and exits with the loop's exit code. |
| `start` / `stop` | Page server in the background / stop it. |
| `serve` | Page server in the foreground. |
| `doctor` | Checks the config, the loop script and every status file against the schema. |
| `set <issue>... -- key=value ...` | Writes status (the same rules as `status-hooks.sh`). |
| `init [--force]` | Copies `loop-status.config.json`, `status-hooks.sh` and `loop-status.AGENTS.md` into the current folder. |
| `template` | Prints the local path of `template/` (the sample loop and its outputs). It is also on GitHub under `tree/v<version>/template`. |

## Writing status

Source `status-hooks.sh` (copied by `init`) in your loop. It needs only bash and node:

```bash
source platform/scripts/status-hooks.sh
status 43 -- state=working agent=slice-owner run=1 step="build run 1" logs=issue-43
status 43 -- turns+=12 cost+=0.84
status 43 44 -- state=in-review pr=101 step=review      # a bundle: shared steps go to every issue
status 43 -- state=needs-you message="approved; waits for the owner to merge"
```

- **Fields:** `title agent branch worktree pr logs bundle step run state message cost turns`.
- **Operators:** `key+=n` adds to a number and `key=` removes a field.
- **What each call stamps:** `updated` every time, `started` once, and a timeline entry whenever `step`, `state` or
  `message` changes (the last 50 are kept).
- **How files are written:** under a lock, through tmp + rename.
- **Errors:** `status` never fails your loop; a bad call prints a warning. `LOOP_STATUS_DIR` overrides the folder
  (default `.build-logs/status`).

## Logs

- **Layout:** `<logsDir>/<logs>/<file>`, where `<logs>` is the folder named in the issue's status file.
- **Bundle folders** (several issues on one branch): files for one issue start with `<issue>-`, and files without a
  number prefix are shared. `issueLogPattern` changes the rule.
- **Kinds:** `logKinds` maps globs to `claude-json` (summarised) or `text` (last 2000 lines, *Show all* for the rest,
  capped at 2 MB).
- **Reviews:** `reviews.md` gets its own *Reviews* tab.

## Config

See `schema/config.schema.json` and `template/loop-status.config.json`. The main keys:

| Key | Default | |
| --- | --- | --- |
| `name` | (required) | Page title. |
| `loop.script`, `loop.args`, `loop.interpreter` | (script required) | What `run` starts. The interpreter defaults to bash for `.sh` and node for `.mjs`/`.js`. |
| `port` | 18092 | Loopback only. |
| `logsDir`, `statusDir` | `.build-logs`, `<logsDir>/status` | |
| `states` | queued, working, in-review, needs-you, blocked, merged | `{id, label, color, done}`; `done` states sort last. |
| `maxRuns` | 2 | Runs ring. |
| `links.issue`, `links.pr` | (none) | URLs with `{n}` / `{pr}`. |
| `theme` | neutral | `light`/`dark` colour tokens, `fonts` (display, body, mono, Google Fonts `stylesheet`), `radius`. Copy them from your design doc and set `designDoc` to its path. |

## Safety

- **Network:** the page binds to 127.0.0.1, rejects any `Host` header other than `127.0.0.1:<port>` or
  `localhost:<port>` (which blocks DNS rebinding), and accepts only GET. It has no write API and no way to start
  anything, because only the CLI runs loops.
- **Rendering:** every value from status files and logs is untrusted agent output and is shown as text, never as HTML.
  A strict CSP, `nosniff` and `no-store` apply.
- **Paths:** logs are served only from inside `logsDir`. Names must be plain, symlinks may not lead out, and `status/`
  and `.loop-status/` are not served.
- **Secrets:** anyone on the machine can open the page, so keep secrets out of your logs.

## Develop

`npm test` runs the unit tests: schema, writer parity between `status-hooks.sh` and `set`, concurrent writes, path
safety, Host and method checks, the runner, and the template loop end to end in demo mode. To regenerate the sample
outputs, run this from `template/`:

```bash
rm -rf .build-logs && LOOP_DEMO=1 bash build-loop.sh 43 && LOOP_DEMO=1 LOOP_DEMO_FAIL=45 bash build-loop.sh --bundle 44,45
```

MIT licence.
