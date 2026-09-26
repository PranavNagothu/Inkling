import "server-only";

// Cache keys for AI results: sha256(provider|model|kind|normalized input). Normalisation makes
// whitespace and key order irrelevant, so the same moment in two sessions (or a re-analysis) hits
// the same entry. The fields are length-prefixed, so a "|" inside one can't collide with another.
import { createHash } from 'node:crypto';

/** JSON with object keys sorted at every depth (undefined fields dropped, like JSON.stringify). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** Trims and collapses whitespace in every string, recursively. */
export function normalizeForKey<T>(value: T): T {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim() as T;
  if (Array.isArray(value)) return value.map(normalizeForKey) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeForKey(v)])) as T;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function aiCacheKey(parts: { provider: string; model: string; kind: string; input: unknown }): string {
  const fields = [parts.provider, parts.model, parts.kind, stableStringify(normalizeForKey(parts.input))];
  return sha256(fields.map((f) => `${f.length}:${f}`).join('|'));
}
