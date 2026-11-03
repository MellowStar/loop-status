import { cpSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalise } from '../../src/config.mjs';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const TEMPLATE = join(ROOT, 'template');

export const tmp = (prefix = 'loop-status-') => mkdtempSync(join(tmpdir(), prefix));

/** A temp copy of template/ (with its sample .build-logs) and a config rooted there. */
export function templateProject(overrides = {}) {
  const dir = tmp();
  cpSync(TEMPLATE, dir, { recursive: true });
  const raw = { name: 'Test', loop: { script: 'build-loop.sh' }, ...overrides };
  return { dir, cfg: normalise(raw, dir) };
}

export const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
