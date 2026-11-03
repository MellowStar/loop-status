// Status page server. Loopback only, GET only, Host header checked (no DNS rebinding), and nothing on it writes or
// starts anything: running the loop is a CLI command, never a page action.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { publicConfig } from './config.mjs';
import { readAll, readOne } from './status.mjs';
import { listLogs, readLog, NAME } from './logs.mjs';
import { loopState } from './run.mjs';

const PAGE = new URL('../web/index.html', import.meta.url);

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const allowedHosts = (port) => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

/** The request handler, separate from listen() so tests can drive it. */
export function handler(cfg, { page = () => readFileSync(PAGE, 'utf8') } = {}) {
  const hosts = allowedHosts(cfg.port);
  return (req, res) => {
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, {
        'content-type': type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy': CSP,
      });
      res.end(req.method === 'HEAD' ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (!hosts.has(String(req.headers.host ?? '').toLowerCase())) return send(403, { error: 'host not allowed' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: 'read only' });
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      return send(400, { error: 'bad url' });
    }
    const p = url.pathname;
    try {
      if (p === '/') return send(200, page(), 'text/html; charset=utf-8');
      if (p === '/api/health') return send(200, { ok: true, name: cfg.name });
      if (p === '/api/config') return send(200, publicConfig(cfg));
      if (p === '/api/issues') return send(200, readAll(cfg.abs.statusDir));
      if (p === '/api/loop') return send(200, loopState(cfg));
      let m = /^\/api\/issues\/(\d{1,9})$/.exec(p);
      if (m) {
        const n = Number(m[1]);
        const status = readOne(cfg.abs.statusDir, n);
        if (!status) return send(404, { error: 'no such issue' });
        const logs = status.logs && NAME.test(status.logs) ? listLogs(cfg, status.logs, n) : [];
        return send(200, { status, logs });
      }
      m = /^\/api\/logs\/([^/]+)\/([^/]+)$/.exec(p);
      if (m) {
        let dir, file;
        try {
          [dir, file] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])];
        } catch {
          return send(404, { error: 'no such log' });
        }
        const log = readLog(cfg, dir, file, { all: url.searchParams.get('all') === '1' });
        return log ? send(200, log) : send(404, { error: 'no such log' });
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      process.stderr.write(`loop-status: ${req.method} ${p}: ${e.stack}\n`);
      return send(500, { error: 'server error' });
    }
  };
}

/** Listens on 127.0.0.1:<port>. Resolves with the server. */
export function serve(cfg, opts) {
  const server = createServer(handler(cfg, opts));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, '127.0.0.1', () => resolve(server));
  });
}
