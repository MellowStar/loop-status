# shellcheck shell=bash
# loop-status writer for build loops. Copy this file into your project and `source` it from your loop; it needs only
# bash and node, not the loop-status package. It follows the same rules as `loop-status set` (src/status.mjs):
#
#   status <issue> [<issue>...] -- key=value [key+=number] [key=] ...
#
#   status 43 -- state=working step="build run 1" run=1 agent=slice-owner branch=agent/x/issue-43 logs=issue-43
#   status 43 -- turns+=12 cost+=0.84          # add to totals
#   status 43 44 45 -- step="review" pr=101    # a bundle: shared steps go to every issue in it
#   status 43 -- message=                      # empty value removes a field
#
# Fields: title agent branch worktree pr logs bundle step run state message cost turns. Each call stamps `updated`,
# keeps `started`, and adds a history entry when step, state or message changes (last 50 kept). Files are
# <LOOP_STATUS_DIR>/<issue>.json (default .build-logs/status), written under a lock via tmp + rename.
# It never fails the caller: a bad call prints a warning to stderr and returns 0.

status() {
  local issues=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do
    issues+=("$1")
    shift
  done
  [ "${1:-}" = -- ] && shift
  node - "${LOOP_STATUS_DIR:-.build-logs/status}" "${issues[*]}" "$@" <<'JS' || true
const fs = require('node:fs'), path = require('node:path');
const [dir, issueList, ...words] = process.argv.slice(2);
try {
  const INTS = new Set(['pr', 'run', 'turns']), NUMS = new Set(['cost']);
  const FIELDS = new Set(['title', 'agent', 'branch', 'worktree', 'pr', 'logs', 'bundle', 'step', 'run', 'state',
    'message', 'cost', 'turns']);
  const ops = words.map((w) => {
    const m = /^([a-z]+)(\+?=)(.*)$/s.exec(w);
    if (!m || !FIELDS.has(m[1])) throw new Error(`not a status field assignment: ${w}`);
    const [, key, eq, raw] = m;
    if (eq === '+=') {
      if (!INTS.has(key) && !NUMS.has(key)) throw new Error(`${key} is not numeric, cannot use +=`);
      const n = Number(raw);
      if (raw === '' || !Number.isFinite(n)) throw new Error(`${key}+= needs a number, got "${raw}"`);
      return { key, op: 'add', value: n };
    }
    if (raw === '') return { key, op: 'del' };
    if (key === 'bundle') {
      const list = raw.split(/[ ,]+/).filter(Boolean).map(Number);
      if (!list.every((n) => Number.isInteger(n) && n > 0)) throw new Error(`bundle needs issue numbers, got "${raw}"`);
      return { key, op: 'set', value: list };
    }
    if (INTS.has(key) || NUMS.has(key)) {
      const n = Number(raw);
      if (!Number.isFinite(n) || (INTS.has(key) && !Number.isInteger(n))) throw new Error(`${key} needs a number, got "${raw}"`);
      return { key, op: 'set', value: n };
    }
    return { key, op: 'set', value: raw };
  });
  const issues = issueList.split(' ').filter(Boolean).map(Number);
  if (!issues.length || !issues.every((n) => Number.isInteger(n) && n > 0)) throw new Error(`issue numbers needed, got "${issueList}"`);
  const now = process.env.LOOP_STATUS_NOW || new Date().toISOString();
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  fs.mkdirSync(dir, { recursive: true });
  for (const issue of issues) {
    const file = path.join(dir, `${issue}.json`), lock = `${file}.lock`;
    for (let i = 0; ; i++) {
      try { fs.mkdirSync(lock); break; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.rmdirSync(lock); } catch {}
        if (i > 300) throw new Error(`could not lock ${file}`);
        sleep(10);
      }
    }
    try {
      let prev;
      try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      const next = { ...(prev ?? {}), issue };
      for (const { key, op, value } of ops) {
        if (op === 'del') delete next[key];
        else if (op === 'add') next[key] = Math.round(((next[key] ?? 0) + value) * 1e6) / 1e6;
        else next[key] = value;
      }
      next.state ??= 'queued';
      next.started ??= now;
      next.updated = now;
      const touched = ops.filter((o) => o.op === 'set' && ['step', 'state', 'message'].includes(o.key));
      if (touched.some((o) => prev?.[o.key] !== o.value) || !prev) {
        const entry = { at: now };
        for (const k of ['step', 'state', 'message']) if (touched.some((o) => o.key === k)) entry[k] = next[k];
        if (!prev && !entry.state) entry.state = next.state;
        next.history = [...(prev?.history ?? []), entry].slice(-50);
      }
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
      fs.renameSync(tmp, file);
    } finally {
      fs.rmdirSync(lock);
    }
  }
} catch (e) {
  process.stderr.write(`status: ${e.message}\n`);
}
JS
}
