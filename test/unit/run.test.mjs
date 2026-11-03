import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { normalise } from '../../src/config.mjs';
import { loopState, runLoop } from '../../src/run.mjs';
import { readAll } from '../../src/status.mjs';
import { ROOT, templateProject, tmp } from './helpers.mjs';

const sink = () => {
  const s = new PassThrough();
  s.text = '';
  s.on('data', (d) => (s.text += d));
  return s;
};

test('run tees output to loop.log, passes args and returns the exit code', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'loop.sh'), 'echo "args: $*"; echo oops >&2; exit 3\n');
  const cfg = normalise({ name: 't', loop: { script: 'loop.sh', args: ['--flow', 'F'] } }, dir);
  const out = sink(), err = sink();
  assert.equal(await runLoop(cfg, ['--once'], { out, err }), 3);
  assert.match(out.text, /args: --flow F --once/);
  assert.match(err.text, /oops/);
  const log = readFileSync(join(dir, '.build-logs/loop.log'), 'utf8');
  assert.match(log, /args: --flow F --once/);
  assert.match(log, /loop exited 3/);
  const st = loopState(cfg);
  assert.equal(st.running, false);
  assert.equal(st.code, 3);
});

test('a second run is refused while one is alive', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'loop.sh'), 'sleep 1\n');
  const cfg = normalise({ name: 't', loop: { script: 'loop.sh' } }, dir);
  const first = runLoop(cfg, [], { out: sink(), err: sink() });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(loopState(cfg).running, true);
  const err = sink();
  assert.equal(await runLoop(cfg, [], { out: sink(), err }), 3);
  assert.match(err.text, /already running/);
  assert.equal(await first, 0);
});

test('a missing script fails cleanly', async () => {
  const dir = tmp();
  const cfg = normalise({ name: 't', loop: { script: 'nope', interpreter: join(dir, 'no-such-binary') } }, dir);
  const err = sink();
  assert.equal(await runLoop(cfg, [], { out: sink(), err }), 127);
  assert.match(err.text, /cannot start/);
});

test('the template loop, run by loop-status in demo mode, writes valid status files', () => {
  const { dir } = templateProject();
  execFileSync('rm', ['-rf', join(dir, '.build-logs')]);
  writeFileSync(join(dir, 'loop-status.config.json'), JSON.stringify({ name: 'demo', loop: { script: 'build-loop.sh' } }));
  execFileSync(process.execPath, [join(ROOT, 'bin/loop-status.mjs'), 'run', '--', '--bundle', '7,8'], {
    cwd: dir,
    env: { ...process.env, LOOP_DEMO: '1', LOOP_STATUS_NO_SERVER: '1' },
    stdio: 'pipe',
  });
  const all = readAll(join(dir, '.build-logs/status'));
  assert.deepEqual(all.map((s) => [s.issue, s.state, s.invalid]).sort(), [[7, 'needs-you', undefined], [8, 'needs-you', undefined]]);
  assert.equal(all[0].pr, 101);
  assert.match(readFileSync(join(dir, '.build-logs/loop.log'), 'utf8'), /loop exited 0/);
});
