import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { applyOps, HISTORY_MAX, parseAssignments, readAll, setStatus } from '../../src/status.mjs';
import { loadSchema, validate } from '../../src/schema.mjs';
import { ROOT, TEMPLATE, tmp } from './helpers.mjs';

const T0 = '2026-01-01T00:00:00.000Z', T1 = '2026-01-01T00:01:00.000Z';

test('assignments parse, coerce numbers and reject unknown fields', () => {
  assert.deepEqual(parseAssignments(['run=2', 'cost+=0.5', 'message=', 'bundle=43,44', 'step=a=b']), [
    { key: 'run', op: 'set', value: 2 },
    { key: 'cost', op: 'add', value: 0.5 },
    { key: 'message', op: 'del' },
    { key: 'bundle', op: 'set', value: [43, 44] },
    { key: 'step', op: 'set', value: 'a=b' },
  ]);
  for (const bad of ['nope=1', 'run=x', 'run=1.5', 'step+=1', 'cost+=', 'bundle=a', 'state'])
    assert.throws(() => parseAssignments([bad]), undefined, bad);
});

test('merge keeps started, stamps updated, adds totals and records step changes', () => {
  const a = applyOps(undefined, 43, parseAssignments(['state=working', 'step=build', 'turns+=3']), T0);
  assert.equal(a.started, T0);
  assert.deepEqual(a.history, [{ at: T0, step: 'build', state: 'working' }]);
  const b = applyOps(a, 43, parseAssignments(['turns+=4', 'cost+=0.1', 'cost+=0.2']), T1);
  assert.equal(b.started, T0);
  assert.equal(b.updated, T1);
  assert.equal(b.turns, 7);
  assert.equal(b.cost, 0.3);
  assert.equal(b.history.length, 1, 'no new entry without a step/state/message change');
  const c = applyOps(b, 43, parseAssignments(['step=build']), T1);
  assert.equal(c.history.length, 1, 'same step again is not a change');
  const d = applyOps(c, 43, parseAssignments(['state=blocked', 'message=tests failed']), T1);
  assert.deepEqual(d.history.at(-1), { at: T1, state: 'blocked', message: 'tests failed' });
});

test('history is capped', () => {
  let s;
  for (let i = 0; i < HISTORY_MAX + 15; i++) s = applyOps(s, 1, parseAssignments([`step=s${i}`]), T0);
  assert.equal(s.history.length, HISTORY_MAX);
  assert.equal(s.history.at(-1).step, `s${HISTORY_MAX + 14}`);
});

test('written files match the schema', () => {
  const dir = tmp();
  setStatus(dir, [43, 44], ['state=working', 'title=<script>x</script>', 'bundle=43,44', 'pr=9', 'logs=bundle-43-44'], T0);
  for (const s of readAll(dir)) assert.deepEqual(validate(s, loadSchema('status')), []);
});

test('concurrent writers lose no update and leave valid JSON', async () => {
  const dir = tmp();
  const writer = `import { setStatus } from ${JSON.stringify(join(ROOT, 'src/status.mjs'))};
    for (let i = 0; i < 20; i++) setStatus(process.argv[1], [7], ['turns+=1']);`;
  await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    spawn(process.execPath, ['--input-type=module', '-e', writer, dir], { stdio: 'inherit' })
      .on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}`))));
  })));
  const s = JSON.parse(readFileSync(join(dir, '7.json'), 'utf8'));
  assert.equal(s.turns, 120);
  assert.deepEqual(readdirSync(dir), ['7.json']);
});

test('status-hooks.sh writes exactly what loop-status set writes', () => {
  const calls = [
    ['43 44', ['state=queued', 'title=Coaches screen', 'bundle=43,44', 'logs=bundle-43-44']],
    ['43', ['state=working', 'step=build run 1', 'run=1', 'turns+=12', 'cost+=0.42']],
    ['43 44', ['step=review', 'pr=101', 'state=in-review']],
    ['44', ['state=needs-you', 'message=waits for the owner', 'cost+=1.5']],
    ['44', ['message=']],
  ];
  const viaHooks = tmp(), viaSet = tmp();
  for (const [issues, words] of calls) {
    execFileSync('bash', ['-c', `source "$1"; shift; status ${issues} -- "$@"`, 'x', join(TEMPLATE, 'status-hooks.sh'), ...words], {
      env: { ...process.env, LOOP_STATUS_DIR: viaHooks, LOOP_STATUS_NOW: T0 },
    });
    setStatus(viaSet, issues.split(' ').map(Number), words, T0);
  }
  for (const f of ['43.json', '44.json'])
    assert.equal(readFileSync(join(viaHooks, f), 'utf8'), readFileSync(join(viaSet, f), 'utf8'), f);
});

test('status-hooks.sh never fails the caller', () => {
  const out = execFileSync('bash', ['-c', `set -e; source "$1"; status 43 -- nope=1; status -- state=x; echo still-here`, 'x',
    join(TEMPLATE, 'status-hooks.sh')], { env: { ...process.env, LOOP_STATUS_DIR: tmp() }, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(String(out), /still-here/);
});

test('the template sample outputs match the schema', () => {
  const all = readAll(join(TEMPLATE, '.build-logs/status'));
  assert.deepEqual(all.map((s) => s.issue).sort(), [43, 44, 45]);
  for (const s of all) assert.equal(s.invalid, undefined, `${s.issue}: ${s.invalid}`);
});
