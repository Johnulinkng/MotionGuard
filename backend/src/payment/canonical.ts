import { createHash } from 'node:crypto';
import { PaymentError, type ResourcePlan } from './types.js';

export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  function normalize(v: unknown): unknown {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') { if (!Number.isSafeInteger(v)) throw new PaymentError('INVALID_INTEGER'); return v; }
    if (typeof v === 'bigint') return v.toString();
    if (typeof v !== 'object' || v === undefined) throw new PaymentError('NON_JSON_VALUE');
    if (seen.has(v)) throw new PaymentError('CYCLIC_VALUE');
    seen.add(v);
    let out: unknown;
    if (Array.isArray(v)) out = v.map(normalize);
    else {
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new PaymentError('NON_PLAIN_OBJECT');
      out = Object.fromEntries(Object.keys(v).sort().map(k => [k, normalize((v as Record<string, unknown>)[k])]));
    }
    seen.delete(v); return out;
  }
  return JSON.stringify(normalize(value));
}
export function sha256(value: unknown): string { return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`; }
/** DRAFT -> FROZEN does not change the immutable plan commitment. */
export function hashResourcePlan(plan: ResourcePlan): string {
  const { planHash: _hash, status: _status, ...immutable } = plan;
  return sha256(immutable);
}
export function atomic(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,29})$/.test(value)) throw new PaymentError('INVALID_ATOMIC_AMOUNT');
  return BigInt(value);
}
export function utcSeconds(value: string): number {
  const ms = Date.parse(value);
  if (!value.endsWith('Z') || !Number.isFinite(ms)) throw new PaymentError('INVALID_EXPIRY');
  return Math.floor(ms / 1000);
}
export function sameAddress(a: string, b: string): boolean { return /^0x[\da-f]{40}$/i.test(a) && /^0x[\da-f]{40}$/i.test(b) && a.toLowerCase() === b.toLowerCase(); }
