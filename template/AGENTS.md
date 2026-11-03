# Adapting a build loop to loop-status

loop-status runs your build loop and shows its progress per issue on a local page (`http://127.0.0.1:18092`), with the
timeline, agent runs, costs and logs. It reads only files. This guide says which files your loop should write.

**The working example** is the package's `template/` folder:
- `build-loop.sh`, the sample loop,
- `status-hooks.sh`,
- `.build-logs/`, the exact files the page reads.

To find it, run `npx loop-status@<version> template` (it prints the local path), or read it on GitHub at
`https://github.com/MellowStar/loop-status/tree/v<version>/template`. To watch the sample produce its files, run
`LOOP_DEMO=1 bash build-loop.sh 43` inside that folder. `LOOP_DEMO` belongs to the sample loop only; your own loop
doesn't know it.

## Steps

1. **Ask the owner before you start a loop.** `loop-status run` starts real agent runs, which cost money. Preparing the
   config and the hooks is your job; starting the loop is theirs.
2. Run `npx loop-status@<version> init` from the repo root. It writes `loop-status.config.json`, `status-hooks.sh` and
   this guide as `loop-status.AGENTS.md`. Move `status-hooks.sh` next to your loop script.
3. Edit the config:
   - `loop.script`: your loop. `loop-status run -- <args>` runs it with those args.
   - `links`: your repo's issue and PR URLs.
   - `states`: keep the defaults unless your board has other columns. Every `state=` your loop writes must be one of
     them.
   - `theme`: copy the colour tokens and fonts from the project's design doc (put its path in `designDoc`). Any token
     you leave out keeps its default.
4. Add `source status-hooks.sh` to your loop and call `status` at each step (table below). `status` never fails the
   loop, so you don't need `|| true`.
5. Run `npx loop-status doctor` and fix every `FAIL`.
6. Document `npx loop-status@<version> run --config <file> -- <loop args>` in the README, pinned to an exact version.

## What to write

`status <issue>... -- key=value ...` writes `<logsDir>/status/<issue>.json` (`schema/status.schema.json`). Write a
**separate file for every issue**, even in a bundle: send shared steps to every issue in it.

| When | Call |
| --- | --- |
| The loop picks an issue | `status 43 -- state=queued title="…" branch=… logs=issue-43` (a bundle adds `bundle=43,44`) |
| An agent run starts | `status 43 -- state=working agent=slice-owner run=1 step="build run 1"` |
| An agent run ends | `status 43 -- turns+=<num_turns> cost+=<total_cost_usd>` |
| PR opened, tests, review | `status 43 -- state=in-review pr=101 step="review"` |
| A review verdict | `status 43 -- message="VERDICT: changes – 2 findings"` |
| Waiting for the owner | `status 43 -- state=needs-you message="why, and what they should do"` |
| Failed, cannot go on | `status 43 -- state=blocked message="what failed; which log to read"` |
| Merged | `status 43 -- state=merged step=merged` |

Each change of `step`, `state` or `message` adds a timeline entry. Keep `step` to a few words and put detail in
`message`.

## Logs

- Put every log under `<logsDir>/<logs>/`, where `<logs>` is the folder named in the status file: `issue-43`, or
  `bundle-43-44` for a bundle.
- In a bundle folder, start a file with `<issue>-` when it belongs to one issue (`43-build-1.json`). Files without a
  number prefix (`review-1.json`, `simplify.json`, `reviews.md`) are shared and show under every issue in the bundle.
  `issueLogPattern` in the config changes that rule.
- Save agent runs as `claude -p … --output-format json > <name>.json`. The page shows their result text, turns, cost
  and success. Other files are shown as text, tailed to the last 2000 lines.
- `reviews.md` gets its own *Reviews* tab.
- Never put secrets in logs. The page shows them to anyone on this machine.

## Safety

- The page binds to 127.0.0.1, accepts only GET, checks the Host header, and shows every value as plain text. Don't
  change those.
- `loop-status run` is the only way it starts anything. Don't add a run button or a write API.
