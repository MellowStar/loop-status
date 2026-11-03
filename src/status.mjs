// Status files: one JSON per issue at <statusDir>/<issue>.json (schema/status.schema.json).
// The loop writes them, normally through template/status-hooks.sh (a copy of the same rules with no package needed);
// `loop-status set` is the same writer as a command. The page only reads.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSchema, validate } from './schema.mjs';

export const HISTORY_MAX = 50;
const INTS = new Set(['pr', 'run', 'turns']);
const NUMS = new Set(['cost']);
const FIELDS = new Set(['title', 'agent', 'branch', 'worktree', 'pr', 'logs', 'bundle', 'step', 'run', 'state',
  'message', 'cost', 'turns']); // prettier-ignore

/**
 * Parses `key=value` / `key+=number` / `key=` (delete) words into ops. Throws on an unknown key or a bad number.
 * @returns {{key: string, op: 'set'|'add'|'del', value?: any}[]}
 */
export function parseAssignments(words) {
  return words.map((w) => {
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
}

/** Pure merge: returns the next status for `issue` from the previous one (or undefined) and the ops. */
export function applyOps(prev, issue, ops, now = new Date().toISOString()) {
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
  const changed = touched.some((o) => prev?.[o.key] !== o.value);
  if (changed || !prev) {
    const entry = { at: now };
    for (const k of ['step', 'state', 'message']) if (touched.some((o) => o.key === k)) entry[k] = next[k];
    if (!prev && !entry.state) entry.state = next.state;
    next.history = [...(prev?.history ?? []), entry].slice(-HISTORY_MAX);
  }
  return next;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Runs fn while holding <file>.lock (mkdir lock; a lock older than 10 s is treated as stale). */
export function withLock(file, fn) {
  const lock = `${file}.lock`;
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) rmdirSync(lock);
      } catch {}
      if (i > 300) throw new Error(`could not lock ${file}`);
      sleep(10);
    }
  }
  try {
    return fn();
  } finally {
    rmdirSync(lock);
  }
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};

/** Applies `words` (key=value...) to each issue's file, atomically. Returns the written statuses. */
export function setStatus(statusDir, issues, words, now) {
  const ops = parseAssignments(words);
  mkdirSync(statusDir, { recursive: true });
  return issues.map((issue) => {
    if (!Number.isInteger(issue) || issue < 1) throw new Error(`not an issue number: ${issue}`);
    const file = join(statusDir, `${issue}.json`);
    return withLock(file, () => {
      const next = applyOps(readJson(file), issue, ops, now);
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
      renameSync(tmp, file);
      return next;
    });
  });
}

/** Every readable status file, newest update first. Files that fail the schema come back with `invalid`. */
export function readAll(statusDir) {
  let names;
  try {
    names = readdirSync(statusDir).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return [];
  }
  const schema = loadSchema('status');
  return names
    .map((n) => {
      const s = readJson(join(statusDir, n));
      if (!s || typeof s !== 'object') return undefined;
      const errors = validate(s, schema);
      return errors.length ? { ...s, issue: Number.parseInt(n, 10), invalid: errors } : s;
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updated ?? '').localeCompare(String(a.updated ?? '')));
}

export const readOne = (statusDir, issue) => readAll(statusDir).find((s) => s.issue === issue);
