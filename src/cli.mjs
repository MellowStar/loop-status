// loop-status commands. Run from the repo root; --config defaults to ./loop-status.config.json.
import { spawn } from 'node:child_process';
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigError, DEFAULT_CONFIG_FILE, loadConfig } from './config.mjs';
import { readAll, setStatus } from './status.mjs';
import { serve } from './server.mjs';
import { alive, runLoop, serverFile } from './run.mjs';
import { join } from 'node:path';

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const BIN = fileURLToPath(new URL('../bin/loop-status.mjs', import.meta.url));
const TEMPLATE = fileURLToPath(new URL('../template/', import.meta.url));

const HELP = `loop-status ${PKG.version}: run an agent build loop and watch it per issue.

  loop-status run [-- <loop args>]   start the page if needed, then run the configured loop (output also in <logsDir>/loop.log)
  loop-status start | stop           page server in the background / stop it
  loop-status serve                  page server in the foreground
  loop-status doctor                 check the config, the loop script and every status file
  loop-status set <issue>... -- key=value ...   write status (loops usually source status-hooks.sh instead)
  loop-status init                   copy the template config, status-hooks.sh and agent guide into this folder
  loop-status template               print the path of the sample loop and the files it produces

Options: --config <file> (default ${DEFAULT_CONFIG_FILE}). Run from the repo root; config paths are relative to it.
Page: http://127.0.0.1:<port> (default 18092). It is read only; only this CLI starts loops.
`;

const url = (cfg) => `http://127.0.0.1:${cfg.port}`;

async function health(cfg) {
  try {
    const r = await fetch(`${url(cfg)}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = await r.json();
    return body?.ok ? body : undefined;
  } catch {
    return undefined;
  }
}

/** Starts the page server detached unless one answers. Returns a message for the user. */
async function ensureServer(cfg, configFile) {
  const h = await health(cfg);
  if (h) return h.name === cfg.name ? `status page: ${url(cfg)}` : `port ${cfg.port} is serving "${h.name}", not "${cfg.name}"`;
  mkdirSync(cfg.abs.stateDir, { recursive: true });
  const log = openSync(join(cfg.abs.stateDir, 'server.log'), 'a');
  const child = spawn(process.execPath, [BIN, 'serve', '--config', configFile], {
    cwd: cfg.cwd,
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 125));
    if (await health(cfg)) return `status page: ${url(cfg)}`;
  }
  return `status page did not start; see ${join(cfg.logsDir, '.loop-status', 'server.log')}`;
}

function doctor(cfg) {
  const lines = [];
  const ok = (m) => lines.push(`ok    ${m}`);
  const fail = (m) => lines.push(`FAIL  ${m}`);
  const warn = (m) => lines.push(`warn  ${m}`);
  ok(`config "${cfg.name}", page on ${url(cfg)}`);
  try {
    accessSync(cfg.abs.script, constants.R_OK);
    ok(`loop script ${cfg.loop.script}`);
  } catch {
    fail(`loop script ${cfg.loop.script} is missing or unreadable`);
  }
  if (existsSync(cfg.abs.logsDir)) ok(`logs in ${cfg.logsDir}`);
  else warn(`${cfg.logsDir} does not exist yet (the loop creates it)`);
  const ids = new Set(cfg.states.map((s) => s.id));
  const all = readAll(cfg.abs.statusDir);
  for (const s of all) {
    if (s.invalid) fail(`status ${s.issue}.json: ${s.invalid.join('; ')}`);
    else if (!ids.has(s.state)) warn(`status ${s.issue}.json: state "${s.state}" is not in the config's states`);
  }
  if (all.length) ok(`${all.length} status file(s) in ${cfg.statusDir}`);
  else warn(`no status files in ${cfg.statusDir} yet`);
  return { text: lines.join('\n'), failed: lines.some((l) => l.startsWith('FAIL')) };
}

function init(force) {
  const copies = [
    ['loop-status.config.json', DEFAULT_CONFIG_FILE],
    ['status-hooks.sh', 'status-hooks.sh'],
    ['AGENTS.md', 'loop-status.AGENTS.md'],
  ];
  const clash = copies.filter(([, to]) => existsSync(to));
  if (clash.length && !force) throw new ConfigError(`already exists: ${clash.map(([, t]) => t).join(', ')} (use --force)`);
  for (const [from, to] of copies) copyFileSync(join(TEMPLATE, from), to);
  return `wrote ${copies.map(([, t]) => t).join(', ')}.
Next: edit ${DEFAULT_CONFIG_FILE} (loop.script, theme), source status-hooks.sh from your loop, then \`loop-status doctor\`.
The sample loop and the files it should produce: \`loop-status template\` prints their path, or see
https://github.com/MellowStar/loop-status/tree/v${PKG.version}/template.`;
}

export async function main(argv, { out = process.stdout, err = process.stderr } = {}) {
  const dd = argv.indexOf('--');
  const rest = dd < 0 ? [] : argv.slice(dd + 1);
  const words = dd < 0 ? argv : argv.slice(0, dd);
  let configFile = DEFAULT_CONFIG_FILE;
  const ci = words.indexOf('--config');
  if (ci >= 0) {
    configFile = words[ci + 1];
    words.splice(ci, 2);
    if (!configFile) return err.write('--config needs a file\n'), 2;
  }
  const force = words.includes('--force');
  const [cmd, ...pos] = words.filter((w) => w !== '--force');
  try {
    switch (cmd) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        out.write(HELP);
        return 0;
      case '--version':
      case 'version':
        out.write(`${PKG.version}\n`);
        return 0;
      case 'init':
        out.write(`${init(force)}\n`);
        return 0;
      case 'template':
        out.write(`${TEMPLATE}\n`);
        return 0;
    }
    const cfg = loadConfig(configFile);
    switch (cmd) {
      case 'serve': {
        const server = await serve(cfg);
        mkdirSync(cfg.abs.stateDir, { recursive: true });
        writeFileSync(serverFile(cfg), JSON.stringify({ pid: process.pid, port: cfg.port }) + '\n');
        out.write(`loop-status: ${url(cfg)} (Ctrl-C to stop)\n`);
        const stop = () => server.close(() => (rmSync(serverFile(cfg), { force: true }), process.exit(0)));
        process.on('SIGINT', stop).on('SIGTERM', stop);
        return await new Promise(() => {});
      }
      case 'start':
        out.write(`${await ensureServer(cfg, configFile)}\n`);
        return 0;
      case 'stop': {
        let s;
        try {
          s = JSON.parse(readFileSync(serverFile(cfg), 'utf8'));
        } catch {}
        if (!s || !alive(s.pid)) return out.write('loop-status: no page server running\n'), 0;
        process.kill(s.pid, 'SIGTERM');
        out.write(`loop-status: stopped the page server (pid ${s.pid})\n`);
        return 0;
      }
      case 'run': {
        if (pos.length) return err.write('put loop arguments after --, e.g. loop-status run -- --once\n'), 2;
        if (process.env.LOOP_STATUS_NO_SERVER !== '1') err.write(`loop-status: ${await ensureServer(cfg, configFile)}\n`);
        return await runLoop(cfg, rest);
      }
      case 'doctor': {
        const d = doctor(cfg);
        out.write(`${d.text}\n`);
        return d.failed ? 1 : 0;
      }
      case 'set': {
        if (dd < 0 || !pos.length) return err.write('usage: loop-status set <issue>... -- key=value ...\n'), 2;
        const issues = pos.map(Number);
        setStatus(cfg.abs.statusDir, issues, rest);
        return 0;
      }
      default:
        err.write(`unknown command ${cmd}\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    err.write(`loop-status: ${e instanceof ConfigError ? e.message : e.message ?? e}\n`);
    return e instanceof ConfigError ? 2 : 1;
  }
}
