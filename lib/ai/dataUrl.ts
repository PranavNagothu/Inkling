import "server-only";

// Validates the before/after crops a client sends for revision reading: PNG data URLs only
// (declared type AND file signature), base64, at most 200 KB decoded each.

export const MAX_PNG_BYTES = 200 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PREFIX = 'data:image/png;base64,';

export type PngResult = { ok: true; bytes: Buffer; dataUrl: string } | { ok: false; status: 400 | 413; error: string };

export function parsePngDataUrl(value: unknown): PngResult {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) {
    return { ok: false, status: 400, error: 'images must be PNG data URLs (data:image/png;base64,…)' };
  }
  const b64 = value.slice(PREFIX.length);
  // Cheap upper bound before decoding: 4 base64 chars carry 3 bytes.
  if (Math.floor((b64.length * 3) / 4) > MAX_PNG_BYTES + 3) {
    return { ok: false, status: 413, error: `each image must be at most ${MAX_PNG_BYTES / 1024} KB` };
  }
  if (b64.length === 0 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    return { ok: false, status: 400, error: 'image data is not valid base64' };
  }
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length > MAX_PNG_BYTES) {
    return { ok: false, status: 413, error: `each image must be at most ${MAX_PNG_BYTES / 1024} KB` };
  }
  if (bytes.length < PNG_SIGNATURE.length || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) {
    return { ok: false, status: 400, error: 'image is not a PNG' };
  }
  return { ok: true, bytes, dataUrl: value };
}
