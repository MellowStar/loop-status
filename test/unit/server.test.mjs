import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '../../src/server.mjs';
import { freePort, ROOT, templateProject } from './helpers.mjs';

let server, cfg;
before(async () => {
  ({ cfg } = templateProject());
  cfg.port = await freePort();
  server = await serve(cfg);
});
after(() => server.close());

/** Raw request so the Host header can be forged. */
function call(path, { method = 'GET', host = `127.0.0.1:${cfg.port}` } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: cfg.port, path, method, headers: { host } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body, json: () => JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('only loopback Host headers are served (no DNS rebinding)', async () => {
  assert.equal((await call('/api/issues')).status, 200);
  assert.equal((await call('/api/issues', { host: `localhost:${cfg.port}` })).status, 200);
  for (const host of ['evil.example', `evil.example:${cfg.port}`, '127.0.0.1', `127.0.0.1:${cfg.port + 1}`])
    assert.equal((await call('/api/issues', { host })).status, 403, host);
});

test('the server is read only', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await call('/api/issues', { method })).status, 405, method);
});

test('it listens on 127.0.0.1 only', () => assert.equal(server.address().address, '127.0.0.1'));

test('every route answers on the template sample data', async () => {
  const issues = (await call('/api/issues')).json();
  assert.deepEqual(issues.map((s) => s.issue).sort(), [43, 44, 45]);
  const one = (await call('/api/issues/43')).json();
  assert.equal(one.status.state, 'needs-you');
  assert.deepEqual(one.logs.map((l) => l.name).sort(), ['build-1.json', 'review-1.json', 'reviews.md', 'tests-1.log']);
  const b = (await call('/api/issues/44')).json();
  assert.deepEqual(b.logs.map((l) => l.name), ['44-build-1.json']);
  const log = (await call('/api/logs/issue-43/build-1.json')).json();
  assert.equal(log.kind, 'claude-json');
  assert.match(log.text, /Demo run/);
  assert.equal((await call('/api/logs/issue-43/reviews.md')).json().kind, 'text');
  const c = (await call('/api/config')).json();
  assert.equal(c.name, 'Test');
  assert.equal((await call('/api/loop')).json().running, false);
  const page = await call('/');
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
});

test('logs outside the folder, status files and unknown issues are 404', async () => {
  for (const p of ['/api/logs/status/43.json', '/api/logs/..%2Fstatus/43.json', '/api/logs/issue-43/..%2F..%2Fstatus%2F43.json',
    '/api/logs/issue-43/%2e%2e', '/api/logs/.loop-status/run.json', '/api/issues/999', '/api/nope', '/api/logs/%E0%A4%A/x'])
    assert.equal((await call(p)).status, 404, p);
});

test('the page never puts API data into HTML', () => {
  const html = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
  assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
});
