// Loads loop-status.config.json, checks it against schema/config.schema.json and fills in defaults.
// Paths in the config are relative to `cwd` (the repo root you run loop-status from).
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadSchema, validate } from './schema.mjs';

export const DEFAULT_CONFIG_FILE = 'loop-status.config.json';

export const DEFAULT_STATES = [
  { id: 'queued', label: 'Queued', color: '#6B7A86' },
  { id: 'working', label: 'Working', color: '#0F7B62' },
  { id: 'in-review', label: 'In review', color: '#6B7A86' },
  { id: 'needs-you', label: 'Needs you', color: '#B7791F' },
  { id: 'blocked', label: 'Blocked', color: '#C2453A' },
  { id: 'merged', label: 'Merged', color: '#1C8A4E', done: true },
];

export const DEFAULT_THEME = {
  light: {
    bg: '#F4F5F7', surface: '#FFFFFF', sunken: '#ECEEF1', border: '#D9DDE3', text: '#1A1F26', muted: '#5F6B78',
    accent: '#2F6FEB', accentSoft: '#DCE7FD', spark: '#E39B2D', sparkSoft: '#FCEBCF', error: '#C2453A',
  },
  dark: {
    bg: '#111418', surface: '#191D23', sunken: '#13161B', border: '#2B313A', text: '#E6E9EE', muted: '#98A2AF',
    accent: '#6E9BF5', accentSoft: '#1D2A44', spark: '#F0B45A', sparkSoft: '#3A2C14', error: '#E06A5F',
  },
  fonts: {
    display: 'system-ui, sans-serif',
    body: 'system-ui, sans-serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  radius: { card: 12, button: 8, input: 8 },
}; // prettier-ignore

export const DEFAULT_LOG_KINDS = [
  { glob: '*.json', kind: 'claude-json' },
  { glob: '*', kind: 'text' },
];

export class ConfigError extends Error {}

/** Validates a parsed config and returns it with defaults applied and absolute paths added. */
export function normalise(raw, cwd = process.cwd()) {
  const errors = validate(raw, loadSchema('config'));
  if (errors.length) throw new ConfigError(`invalid config:\n  ${errors.join('\n  ')}`);
  const logsDir = raw.logsDir ?? '.build-logs';
  const theme = raw.theme ?? {};
  const states = raw.states ?? DEFAULT_STATES;
  if (new Set(states.map((s) => s.id)).size !== states.length) throw new ConfigError('invalid config: duplicate state id');
  return {
    name: raw.name,
    port: raw.port ?? 18092,
    logsDir,
    statusDir: raw.statusDir ?? join(logsDir, 'status'),
    loop: { args: [], ...raw.loop },
    states,
    maxRuns: raw.maxRuns ?? 2,
    links: raw.links ?? {},
    logKinds: raw.logKinds ?? DEFAULT_LOG_KINDS,
    issueLogPattern: raw.issueLogPattern ?? '^{n}-',
    theme: {
      light: { ...DEFAULT_THEME.light, ...theme.light },
      dark: { ...DEFAULT_THEME.dark, ...theme.dark },
      fonts: { ...DEFAULT_THEME.fonts, ...theme.fonts },
      radius: { ...DEFAULT_THEME.radius, ...theme.radius },
    },
    designDoc: raw.designDoc,
    cwd,
    abs: {
      logsDir: resolve(cwd, logsDir),
      statusDir: resolve(cwd, raw.statusDir ?? join(logsDir, 'status')),
      stateDir: resolve(cwd, logsDir, '.loop-status'),
      script: resolve(cwd, raw.loop.script),
    },
  };
}

export function loadConfig(file = DEFAULT_CONFIG_FILE, cwd = process.cwd()) {
  let text;
  try {
    text = readFileSync(resolve(cwd, file), 'utf8');
  } catch {
    throw new ConfigError(`no config at ${file} (run \`loop-status init\` or pass --config)`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`${file} is not valid JSON: ${e.message}`);
  }
  return normalise(raw, cwd);
}

/** The part of the config the page may see: no paths. */
export const publicConfig = (c) => ({
  name: c.name,
  states: c.states,
  maxRuns: c.maxRuns,
  links: c.links,
  theme: c.theme,
  loop: { script: c.loop.script, args: c.loop.args },
});
