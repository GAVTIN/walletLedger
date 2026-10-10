import { config } from '../config';
import { errors } from '../errors';

export function asObject(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw errors.validation('request body must be a JSON object');
  return body as Record<string, unknown>;
}

/** Amounts are integer paise. Strings, floats, zero and negatives are all rejected. */
export function reqAmount(v: unknown, name = 'amount'): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0 || v > config.maxAmountPaise) {
    throw errors.validation(`${name} must be a positive integer number of paise (max ${config.maxAmountPaise})`);
  }
  return v;
}

export function reqId(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
    throw errors.validation(`${name} must be a positive integer`);
  }
  return v;
}

/** Path parameters arrive as strings. */
export function pathId(v: unknown, name: string): number {
  if (typeof v !== 'string' || !/^\d{1,15}$/.test(v) || Number(v) <= 0) {
    throw errors.validation(`${name} must be a positive integer`);
  }
  return Number(v);
}

export function reqString(v: unknown, name: string, max: number): string {
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > max) {
    throw errors.validation(`${name} must be a non-empty string of at most ${max} characters`);
  }
  return v.trim();
}

export function optString(v: unknown, name: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > max) throw errors.validation(`${name} must be a string of at most ${max} characters`);
  return v.trim() === '' ? null : v.trim();
}

export function reqEmail(v: unknown): string {
  const s = reqString(v, 'email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw errors.validation('email is not valid');
  return s;
}

export function reqPhone(v: unknown): string {
  const s = reqString(v, 'phone', 20).replace(/[\s-]/g, '');
  if (!/^\+?[0-9]{7,15}$/.test(s)) throw errors.validation('phone must be 7-15 digits, optional leading +');
  return s;
}

export function queryInt(v: unknown, name: string, def: number, min: number, max: number): number {
  if (v === undefined) return def;
  if (typeof v !== 'string' || !/^\d{1,9}$/.test(v)) throw errors.validation(`${name} must be an integer`);
  const n = Number(v);
  if (n < min || n > max) throw errors.validation(`${name} must be between ${min} and ${max}`);
  return n;
}
