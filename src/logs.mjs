// Build logs under <logsDir>/<folder>/<file>. Logs are agent output: untrusted data, shown as text only.
import { closeSync, fstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

export const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
export const RESERVED = new Set(['status', '.loop-status']);
export const MAX_BYTES = 2 * 1024 * 1024;
export const TAIL_LINES = 2000;

const globRe = (g) =>
  new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

export const kindOf = (name, logKinds) => logKinds.find((k) => globRe(k.glob).test(name))?.kind ?? 'text';

/**
 * Resolves <logsDir>/<dir>[/<file>] or returns undefined: names must be plain, not reserved, and the real path
 * must stay inside logsDir (so symlinks cannot point out).
 */
export function safePath(logsDir, dir, file) {
  if (!NAME.test(dir) || RESERVED.has(dir) || dir.includes('..')) return undefined;
  if (file !== undefined && (!NAME.test(file) || file.includes('..') || file.endsWith('.lock'))) return undefined;
  try {
    const root = realpathSync(logsDir);
    const real = realpathSync(file === undefined ? join(logsDir, dir) : join(logsDir, dir, file));
    return real.startsWith(root + sep) ? real : undefined;
  } catch {
    return undefined;
  }
}

/** Does `name` belong to issue n in a (possibly shared) logs folder? */
export function belongsTo(name, n, pattern) {
  if (!/^\d+-/.test(name)) return true; // shared: review-1.json, simplify.json, reviews.md, worker.log
  return new RegExp(pattern.replaceAll('{n}', String(n))).test(name);
}

function readHead(file, max) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, max));
    readSync(fd, buf, 0, buf.length, 0);
    return { text: buf.toString('utf8'), size, truncated: size > max };
  } finally {
    closeSync(fd);
  }
}

function readTail(file, max) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return { text: buf.toString('utf8'), size, truncated: size > max };
  } finally {
    closeSync(fd);
  }
}

/** Summary of a `claude -p --output-format json` result, or undefined if the file isn't one. */
export function claudeSummary(file) {
  let r;
  try {
    const { text, truncated } = readHead(file, MAX_BYTES);
    if (truncated) return undefined;
    r = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return undefined;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return {
    subtype: typeof r.subtype === 'string' ? r.subtype : undefined,
    ok: r.subtype === 'success' && !r.is_error,
    turns: num(r.num_turns),
    cost: num(r.total_cost_usd),
    durationMs: num(r.duration_ms),
    tokens: num(r.usage?.input_tokens) !== undefined ? r.usage.input_tokens + (num(r.usage.output_tokens) ?? 0) : undefined,
    result: typeof r.result === 'string' ? r.result : undefined,
  };
}

/** Log files in <logsDir>/<dir> for issue n (all files when n is undefined), oldest first. */
export function listLogs(cfg, dir, n) {
  const path = safePath(cfg.abs.logsDir, dir);
  if (!path) return [];
  let names;
  try {
    names = readdirSync(path);
  } catch {
    return [];
  }
  return names
    .filter((name) => NAME.test(name) && !name.endsWith('.tmp') && !name.endsWith('.lock'))
    .filter((name) => n === undefined || belongsTo(name, n, cfg.issueLogPattern))
    .map((name) => {
      const file = safePath(cfg.abs.logsDir, dir, name);
      if (!file) return undefined;
      const st = statSync(file);
      if (!st.isFile()) return undefined;
      const kind = kindOf(name, cfg.logKinds);
      const entry = { name, kind, size: st.size, mtime: st.mtime.toISOString() };
      if (kind === 'claude-json') {
        const s = claudeSummary(file);
        if (s) Object.assign(entry, { ok: s.ok, subtype: s.subtype, turns: s.turns, cost: s.cost });
        else entry.kind = 'text';
      }
      return entry;
    })
    .filter(Boolean)
    .sort((a, b) => a.mtime.localeCompare(b.mtime) || a.name.localeCompare(b.name));
}

/** The last `lines` lines of any file (empty string if missing). */
export function tailText(file, lines = 200) {
  try {
    const { text, truncated } = readTail(file, 256 * 1024);
    const all = text.split('\n');
    return (truncated ? all.slice(1) : all).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/** One log for the viewer: claude-json gets its summary + result text; text gets its last TAIL_LINES lines. */
export function readLog(cfg, dir, name, { all = false } = {}) {
  const file = safePath(cfg.abs.logsDir, dir, name);
  if (!file || !statSync(file).isFile()) return undefined;
  if (kindOf(name, cfg.logKinds) === 'claude-json') {
    const s = claudeSummary(file);
    if (s) return { name, kind: 'claude-json', ...s, text: s.result ?? '' };
  }
  const { text, size, truncated } = readTail(file, MAX_BYTES);
  let lines = text.split('\n');
  if (truncated) lines = lines.slice(1); // first line may be cut mid-way
  const total = lines.length;
  if (!all && lines.length > TAIL_LINES) lines = lines.slice(-TAIL_LINES);
  return { name, kind: 'text', size, text: lines.join('\n'), shownLines: lines.length, totalLines: total, truncated: truncated || lines.length < total };
}
