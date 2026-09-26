// HTTP Range header parsing for media streaming (RFC 9110 §14). Single ranges only.

export type RangeResult =
  /** No (usable) Range header: serve the whole file with 200. */
  | { kind: 'full' }
  /** Serve bytes start..end inclusive with 206. */
  | { kind: 'partial'; start: number; end: number }
  /** 416 Range Not Satisfiable. */
  | { kind: 'unsatisfiable' };

/**
 * Parses `bytes=a-b`, `bytes=a-` and `bytes=-n` against a file of `size` bytes. Non-byte units and
 * multi-range requests fall back to the full body (allowed by the RFC); malformed or out-of-range
 * byte ranges are unsatisfiable.
 */
export function parseRange(header: string | null | undefined, size: number): RangeResult {
  if (!header) return { kind: 'full' };
  const m = /^\s*bytes\s*=\s*(.*)$/i.exec(header);
  if (!m) return { kind: 'full' };
  const spec = m[1].trim();
  if (spec.includes(',')) return { kind: 'full' };
  const r = /^(\d*)\s*-\s*(\d*)$/.exec(spec);
  if (!r || (r[1] === '' && r[2] === '')) return { kind: 'unsatisfiable' };
  if (size <= 0) return { kind: 'unsatisfiable' };

  if (r[1] === '') {
    // Suffix range: the last n bytes.
    const n = Number(r[2]);
    if (!Number.isSafeInteger(n) || n <= 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(r[1]);
  const end = r[2] === '' ? size - 1 : Math.min(Number(r[2]), size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { kind: 'unsatisfiable' };
  if (start >= size || start > end) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start, end };
}
