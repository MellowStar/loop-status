// Runs the project's build loop (config loop.script) with its output teed to <logsDir>/loop.log, one run at a time.
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, extname } from 'node:path';
import { tailText } from './logs.mjs';

export const alive = (pid) => {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};

export const runFile = (cfg) => join(cfg.abs.stateDir, 'run.json');
export const serverFile = (cfg) => join(cfg.abs.stateDir, 'server.json');

/** Is a loop running, what it was started with, how the last one ended, and the end of loop.log. */
export function loopState(cfg) {
  const r = readJson(runFile(cfg)) ?? {};
  const running = r.ended === undefined && alive(r.pid);
  return {
    running,
    started: r.started,
    ended: r.ended,
    code: r.code,
    args: Array.isArray(r.args) ? r.args : [],
    stale: r.ended === undefined && r.pid !== undefined && !running,
    log: tailText(join(cfg.abs.logsDir, 'loop.log'), 200),
  };
}

export function command(cfg, args) {
  const script = cfg.abs.script;
  const interp = cfg.loop.interpreter ?? ({ '.sh': 'bash', '.mjs': process.execPath, '.js': process.execPath }[extname(script)]);
  const all = [...cfg.loop.args, ...args];
  return interp ? [interp, [script, ...all]] : [script, all];
}

/**
 * Runs the loop; resolves with its exit code. Refuses (code 3) while another run is alive.
 * `out`/`err` default to the terminal; everything also goes to <logsDir>/loop.log.
 */
export function runLoop(cfg, args, { out = process.stdout, err = process.stderr, env = process.env } = {}) {
  mkdirSync(cfg.abs.stateDir, { recursive: true });
  const prev = readJson(runFile(cfg));
  if (prev && prev.ended === undefined && alive(prev.pid)) {
    err.write(`loop-status: a loop is already running (pid ${prev.pid}, started ${prev.started}).\n`);
    return Promise.resolve(3);
  }
  const [cmd, argv] = command(cfg, args);
  const log = createWriteStream(join(cfg.abs.logsDir, 'loop.log'), { flags: 'a' });
  const started = new Date().toISOString();
  log.write(`\n== ${started} loop-status run: ${cfg.loop.script} ${[...cfg.loop.args, ...args].join(' ')}\n`);
  const child = spawn(cmd, argv, { cwd: cfg.cwd, env, stdio: ['inherit', 'pipe', 'pipe'] });
  const record = (extra) =>
    writeFileSync(runFile(cfg), JSON.stringify({ pid: child.pid, started, args, ...extra }, null, 2) + '\n');
  record({});
  child.stdout.on('data', (d) => (out.write(d), log.write(d)));
  child.stderr.on('data', (d) => (err.write(d), log.write(d)));
  const forward = (sig) => () => child.kill(sig);
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => [s, forward(s)]);
  for (const [s, h] of handlers) process.on(s, h);
  return new Promise((resolve) => {
    let finished = false;
    const done = (code) => {
      if (finished) return;
      finished = true;
      for (const [s, h] of handlers) process.off(s, h);
      const ended = new Date().toISOString();
      record({ ended, code });
      log.end(`== ${ended} loop exited ${code}\n`, () => resolve(code));
    };
    child.on('error', (e) => {
      err.write(`loop-status: cannot start ${cfg.loop.script}: ${e.message}\n`);
      done(127);
    });
    child.on('close', (code, signal) => done(code ?? (signal ? 128 : 1)));
  });
}

export const clearRun = (cfg) => rmSync(runFile(cfg), { force: true });
