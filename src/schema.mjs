// A small JSON Schema checker for the subset the two schemas in schema/ use, so the package needs no dependencies.
// Supports: type, required, properties, additionalProperties, items, enum, pattern, minimum, maximum, minLength,
// minItems, maxItems, propertyNames.enum, format date-time and local $ref (#/$defs/...).
import { readFileSync } from 'node:fs';

const here = new URL('../schema/', import.meta.url);
export const loadSchema = (name) => JSON.parse(readFileSync(new URL(`${name}.schema.json`, here), 'utf8'));

const typeOf = (v) =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
const isType = (v, t) => (t === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeOf(v) === t);
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Returns a list of "path: problem" strings; empty means valid. */
export function validate(value, schema, root = schema, path = '$') {
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, '').split('/').reduce((s, k) => s?.[k], root);
    if (!target) return [`${path}: unknown $ref ${schema.$ref}`];
    return validate(value, target, root, path);
  }
  const errors = [];
  const err = (m) => errors.push(`${path}: ${m}`);
  if (schema.type && !isType(value, schema.type)) {
    err(`expected ${schema.type}, got ${typeOf(value)}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) err(`must be one of ${schema.enum.join(', ')}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) err(`shorter than ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) err(`does not match ${schema.pattern}`);
    if (schema.format === 'date-time' && !DATE_TIME.test(value)) err('not an ISO date-time');
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) err(`below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) err(`above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) err(`fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) err(`more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(v, schema.items, root, `${path}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    for (const k of schema.required ?? []) if (!(k in value)) err(`missing ${k}`);
    for (const [k, v] of Object.entries(value)) {
      const p = `${path}.${k}`;
      if (schema.propertyNames?.enum && !schema.propertyNames.enum.includes(k)) {
        errors.push(`${p}: unknown key`);
        continue;
      }
      if (schema.properties?.[k]) errors.push(...validate(v, schema.properties[k], root, p));
      else if (schema.additionalProperties === false) errors.push(`${p}: unknown key`);
      else if (typeof schema.additionalProperties === 'object')
        errors.push(...validate(v, schema.additionalProperties, root, p));
    }
  }
  return errors;
}
