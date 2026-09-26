import { describe, expect, it } from 'vitest';
import { MAX_PNG_BYTES, parsePngDataUrl } from '../ai/dataUrl';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (extra = 16) => Buffer.concat([PNG_MAGIC, Buffer.alloc(extra, 1)]);
const url = (buf: Buffer, mime = 'image/png') => `data:${mime};base64,${buf.toString('base64')}`;

describe('parsePngDataUrl', () => {
  it('accepts a small PNG data URL and returns its bytes', () => {
    const r = parsePngDataUrl(url(png()));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes.length).toBe(24);
  });

  it('rejects other MIME types, non-base64, and non-strings', () => {
    expect(parsePngDataUrl(url(png(), 'image/jpeg'))).toMatchObject({ ok: false, status: 400 });
    expect(parsePngDataUrl(url(png(), 'image/svg+xml'))).toMatchObject({ ok: false, status: 400 });
    expect(parsePngDataUrl('data:image/png,rawtext')).toMatchObject({ ok: false, status: 400 });
    expect(parsePngDataUrl('data:image/png;base64,@@@')).toMatchObject({ ok: false, status: 400 });
    expect(parsePngDataUrl(42)).toMatchObject({ ok: false, status: 400 });
    expect(parsePngDataUrl('https://example.com/a.png')).toMatchObject({ ok: false, status: 400 });
  });

  it('checks the PNG signature, not just the declared type', () => {
    expect(parsePngDataUrl(url(Buffer.from('GIF89a-not-a-png'), 'image/png'))).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses images over the size cap with 413', () => {
    expect(MAX_PNG_BYTES).toBe(200 * 1024);
    expect(parsePngDataUrl(url(png(MAX_PNG_BYTES)))).toMatchObject({ ok: false, status: 413 });
  });
});
