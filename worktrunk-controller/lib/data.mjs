import { createHash } from 'node:crypto';

export function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}

export function text(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${name} must be a nonempty string`);
  return value;
}

export function integer(value, name, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be an integer >= ${min}`);
  return value;
}

export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Cannot persist undefined/nonfinite data');
  return JSON.stringify(value);
}

export function digest(value) {
  return createHash('sha256').update(stable(value)).digest('hex');
}
