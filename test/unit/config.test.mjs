import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, normalise, publicConfig } from '../../src/config.mjs';
import { TEMPLATE } from './helpers.mjs';

test('the template config is valid', () => {
  const raw = JSON.parse(readFileSync(join(TEMPLATE, 'loop-status.config.json'), 'utf8'));
  const cfg = normalise(raw, '/repo');
  assert.equal(cfg.port, 18092);
  assert.equal(cfg.abs.statusDir, '/repo/.build-logs/status');
  assert.equal(cfg.abs.script, '/repo/build-loop.sh');
});

test('defaults fill in a minimal config', () => {
  const cfg = normalise({ name: 'x', loop: { script: 'loop.sh' } }, '/r');
  assert.equal(cfg.logsDir, '.build-logs');
  assert.equal(cfg.issueLogPattern, '^{n}-');
  assert.deepEqual(cfg.loop.args, []);
  assert.ok(cfg.states.find((s) => s.id === 'needs-you'));
  assert.match(cfg.theme.light.accent, /^#/);
});

test('bad configs are rejected with the path of the problem', () => {
  const bad = [
    [{ loop: { script: 'x' } }, /missing name/],
    [{ name: 'x' }, /missing loop/],
    [{ name: 'x', loop: { script: 'x' }, port: 80 }, /port: below 1024/],
    [{ name: 'x', loop: { script: 'x' }, extra: 1 }, /extra: unknown key/],
    [{ name: 'x', loop: { script: 'x' }, theme: { light: { accent: 'red' } } }, /accent: does not match/],
    [{ name: 'x', loop: { script: 'x' }, theme: { light: { nope: '#000000' } } }, /nope: unknown key/],
    [{ name: 'x', loop: { script: 'x' }, links: { pr: 'javascript:alert(1)' } }, /pr: does not match/],
    [{ name: 'x', loop: { script: 'x' }, theme: { fonts: { stylesheet: 'https://evil.example/x.css' } } }, /stylesheet/],
    [{ name: 'x', loop: { script: 'x' }, states: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }, /duplicate state/],
  ];
  for (const [raw, re] of bad) assert.throws(() => normalise(raw), (e) => e instanceof ConfigError && re.test(e.message), JSON.stringify(raw));
});

test('the page config carries no filesystem paths', () => {
  const p = publicConfig(normalise({ name: 'x', loop: { script: 'loop.sh' } }, '/secret/repo'));
  assert.doesNotMatch(JSON.stringify(p), /secret/);
});
