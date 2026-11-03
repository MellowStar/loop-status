#!/usr/bin/env bash
# Sample build loop for loop-status. Copy it as a starting point, or read it to see where your own loop should call
# `status` and which log files it should leave. Replace the four marked functions with your project's commands.
#
#   build-loop.sh <issue>...          work these issues (one each, or several as a bundle with --bundle)
#   build-loop.sh --bundle 43,44      several issues on one branch and one PR
#   LOOP_DEMO=1 build-loop.sh 43      no agents, gh or git: fakes each step so you can see the page fill in
#
# Contract (see AGENTS.md):
#   status files   .build-logs/status/<issue>.json, written only through `status` (status-hooks.sh)
#   logs           .build-logs/<logs>/...; one folder per issue (issue-43) or per bundle (bundle-43-44).
#                  In a bundle folder, files for one issue start with "<issue>-" (43-build-1.json); shared ones don't.
#   agent logs     `claude -p ... --output-format json > <file>.json`: the page shows result, turns, cost, ok/error.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=status-hooks.sh
source "$HERE/status-hooks.sh"
LOGS_ROOT=${LOGS_ROOT:-.build-logs}
MAX_RUNS=${MAX_RUNS:-2}
DEMO=${LOOP_DEMO:-0}

# --- replace these four with your project's commands -----------------------------------------------------------------

issue_title() { # <issue> -> one line
  if [ "$DEMO" = 1 ]; then echo "Demo issue $1"; else gh issue view "$1" --json title --jq .title; fi
}

# agent <log file> <prompt>: one agent run; its JSON result goes to the log file. Succeeds when the run succeeded.
agent() {
  if [ "$DEMO" = 1 ]; then
    sleep "${LOOP_DEMO_SLEEP:-0}"
    local subtype=success # LOOP_DEMO_FAIL="45" makes every run for #45 hit its turn cap
    [[ " ${LOOP_DEMO_FAIL:-} " == *" ${2##*#} "* ]] && subtype=error_max_turns
    printf '{"type":"result","subtype":"%s","is_error":false,"num_turns":%d,"total_cost_usd":%s,"duration_ms":%d,"result":%s,"usage":{"input_tokens":1200,"output_tokens":800}}\n' \
      "$subtype" 12 0.42 95000 "$(node -p 'JSON.stringify(process.argv[1])' "Demo run for: ${2:0:60}")" > "$1"
  else
    claude -p "$2" --output-format json > "$1" || true
  fi
  [ "$(node -p 'const r=require(process.argv[1]); r.subtype==="success" && !r.is_error' "$PWD/$1")" = true ]
}

open_pr() { # <branch> <issues...> -> PR number
  if [ "$DEMO" = 1 ]; then echo 101; else
    local url
    url=$(gh pr create --head "$1" --title "Issues ${*:2}" --body "$(printf 'Closes #%s\n' "${@:2}")")
    echo "${url##*/}"
  fi
}

run_tests() { # -> output; fails when tests fail
  if [ "$DEMO" = 1 ]; then echo "demo: 42 tests passed"; else bash scripts/test-all.sh; fi
}

# --- loop ----------------------------------------------------------------------------------------------------------

# usage <agent log>: add that run's turns and cost to every issue in $ISSUES
usage() {
  local t c
  read -r t c < <(node -p 'const r=require(process.argv[1]); `${r.num_turns ?? 0} ${r.total_cost_usd ?? 0}`' "$PWD/$1")
  status $ISSUES -- turns+="$t" cost+="$c"
}

park() { # <state> <message>: stop for the owner
  status $ISSUES -- state="$1" step="stopped" message="$2"
  exit 0
}

work() { # issues...
  ISSUES="$*"
  local first=$1 last=${*: -1} dir run n pr
  if [ $# -gt 1 ]; then dir="bundle-$first-$last"; else dir="issue-$first"; fi
  local branch="agent/loop/$dir" logs="$LOGS_ROOT/$dir"
  mkdir -p "$logs"
  for n in "$@"; do
    status "$n" -- state=queued title="$(issue_title "$n")" branch="$branch" logs="$dir" step="claimed" \
      ${2:+bundle="$(tr ' ' , <<< "$*")"}
  done
  trap 'park blocked "stopped on an error at line $LINENO; see $logs/"' ERR

  # One agent per issue. In a bundle folder, per-issue logs start with "<issue>-".
  for n in "$@"; do
    local prefix=""
    [ $# -gt 1 ] && prefix="$n-"
    for run in $(seq "$MAX_RUNS"); do
      status "$n" -- state=working step="build run $run" run="$run" agent=builder
      if agent "$logs/${prefix}build-$run.json" "Work issue #$n"; then
        ISSUES=$n usage "$logs/${prefix}build-$run.json"
        break
      fi
      ISSUES=$n usage "$logs/${prefix}build-$run.json"
      [ "$run" = "$MAX_RUNS" ] && ISSUES="$*" park blocked "#$n did not finish in $MAX_RUNS runs"
    done
  done

  ISSUES="$*"
  status $ISSUES -- step="tests"
  run_tests > "$logs/tests-1.log" 2>&1 || park blocked "tests failed; see tests-1.log"
  pr=$(open_pr "$branch" "$@")
  status $ISSUES -- state=in-review step="review" pr="$pr"
  agent "$logs/review-1.json" "Review PR #$pr" || park blocked "the review run failed"
  usage "$logs/review-1.json"
  printf '## reviewer\n\n%s\n' "$(node -p 'require(process.argv[1]).result' "$PWD/$logs/review-1.json")" > "$logs/reviews.md"
  park needs-you "PR #$pr is tested and reviewed; it waits for the owner to merge."
}

if [ "${1:-}" = --bundle ]; then
  IFS=, read -r -a list <<< "${2:?usage: build-loop.sh --bundle 43,44}"
  work "${list[@]}"
else
  [ $# -gt 0 ] || { echo 'usage: build-loop.sh <issue>... | --bundle N,N' >&2 && exit 2; }
  for n in "$@"; do (work "$n"); done
fi
