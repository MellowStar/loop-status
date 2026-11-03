import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { belongsTo, claudeSummary, kindOf, listLogs, readLog, safePath, TAIL_LINES } from '../../src/logs.mjs';
import { DEFAULT_LOG_KINDS } from '../../src/config.mjs';
import { templateProject, tmp } from './helpers.mjs';

test('safePath stays inside logsDir', () => {
  const { cfg } = templateProject();
  const L = cfg.abs.logsDir;
  assert.ok(safePath(L, 'issue-43', 'build-1.json'));
  for (const [d, f] of [['..', 'x'], ['issue-43', '..'], ['issue-43', '../status/43.json'], ['/etc', 'passwd'],
    ['status', '43.json'], ['.loop-status', 'run.json'], ['issue-43', '.hidden'], ['issue-43', 'missing.log']])
    assert.equal(safePath(L, d, f), undefined, `${d}/${f}`);
  const outside = tmp();
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  symlinkSync(join(outside, 'secret.txt'), join(L, 'issue-43', 'link.txt'));
  symlinkSync(outside, join(L, 'linkdir'));
  assert.equal(safePath(L, 'issue-43', 'link.txt'), undefined, 'symlinked file out');
  assert.equal(safePath(L, 'linkdir', 'secret.txt'), undefined, 'symlinked dir out');
});

test('bundle folders: an issue sees its own prefixed files and the shared ones', () => {
  assert.ok(belongsTo('44-build-1.json', 44, '^{n}-'));
  assert.ok(!belongsTo('45-build-1.json', 44, '^{n}-'));
  assert.ok(!belongsTo('144-build-1.json', 44, '^{n}-'));
  assert.ok(belongsTo('review-1.json', 44, '^{n}-'));
  const { cfg } = templateProject();
  assert.deepEqual(listLogs(cfg, 'bundle-44-45', 44).map((l) => l.name), ['44-build-1.json']);
  assert.deepEqual(listLogs(cfg, 'bundle-44-45', 45).map((l) => l.name).sort(), ['45-build-1.json', '45-build-2.json']);
});

test('claude -p results are summarised; anything else is text', () => {
  const { cfg } = templateProject();
  const [ok] = listLogs(cfg, 'bundle-44-45', 44);
  assert.equal(ok.kind, 'claude-json');
  assert.equal(ok.ok, true);
  assert.equal(ok.turns, 12);
  const failed = listLogs(cfg, 'bundle-44-45', 45)[0];
  assert.equal(failed.ok, false);
  assert.equal(failed.subtype, 'error_max_turns');
  const dir = tmp();
  writeFileSync(join(dir, 'x.json'), '[1,2]');
  assert.equal(claudeSummary(join(dir, 'x.json')), undefined);
  assert.equal(kindOf('reviews.md', DEFAULT_LOG_KINDS), 'text');
});

test('text logs are tailed; ?all returns everything', () => {
  const { cfg } = templateProject();
  mkdirSync(join(cfg.abs.logsDir, 'issue-9'));
  writeFileSync(join(cfg.abs.logsDir, 'issue-9', 'worker.log'), Array.from({ length: TAIL_LINES + 500 }, (_, i) => `line ${i}`).join('\n'));
  const tail = readLog(cfg, 'issue-9', 'worker.log');
  assert.equal(tail.shownLines, TAIL_LINES);
  assert.equal(tail.truncated, true);
  assert.match(tail.text, /line 2499$/);
  assert.equal(readLog(cfg, 'issue-9', 'worker.log', { all: true }).shownLines, TAIL_LINES + 500);
  assert.equal(readLog(cfg, 'issue-9', '../../etc/passwd'), undefined);
});
