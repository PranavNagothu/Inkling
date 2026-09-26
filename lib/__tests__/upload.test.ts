import { describe, expect, it } from 'vitest';
import {
  MAX_CAPTIONS_BYTES,
  MAX_MEDIA_BYTES,
  checkCaptionsFile,
  checkMediaFile,
  extensionOf,
  isStoredFileName,
  parseDurationMs,
  sanitizeTitle,
  sniffContainer,
  storedFileName,
  titleFromFileName,
} from '../upload';
import { parseRange } from '../range';

const file = (name: string, type: string, size = 1000) => ({ name, type, size });

describe('checkMediaFile (allowlist: extension + MIME + size)', () => {
  it('accepts supported audio and video, reporting kind and canonical MIME', () => {
    expect(checkMediaFile(file('talk.mp3', 'audio/mpeg'))).toEqual({
      ok: true,
      value: { ext: '.mp3', mediaType: 'audio', mime: 'audio/mpeg', container: 'mp3' },
    });
    expect(checkMediaFile(file('Talk.M4A', 'audio/x-m4a'))).toMatchObject({ ok: true, value: { mime: 'audio/mp4' } });
    expect(checkMediaFile(file('a.wav', 'audio/wav'))).toMatchObject({ ok: true, value: { mediaType: 'audio' } });
    expect(checkMediaFile(file('a.webm', 'audio/webm'))).toMatchObject({ ok: true, value: { mediaType: 'audio' } });
    expect(checkMediaFile(file('a.webm', 'video/webm'))).toMatchObject({
      ok: true,
      value: { mediaType: 'video', mime: 'video/webm' },
    });
    expect(checkMediaFile(file('lecture.mp4', 'video/mp4'))).toMatchObject({ ok: true, value: { mediaType: 'video' } });
    expect(checkMediaFile(file('a.wav', 'audio/wav; codecs=1'))).toMatchObject({ ok: true });
  });

  it('rejects other extensions, mismatched or missing MIME types', () => {
    expect(checkMediaFile(file('virus.exe', 'application/x-msdownload')).ok).toBe(false);
    expect(checkMediaFile(file('notes.exe', 'audio/mpeg')).ok).toBe(false);
    expect(checkMediaFile(file('clip.mov', 'video/quicktime')).ok).toBe(false);
    expect(checkMediaFile(file('a.mp3', 'video/mp4')).ok).toBe(false);
    expect(checkMediaFile(file('a.mp3', 'text/html')).ok).toBe(false);
    expect(checkMediaFile(file('a.mp3', '')).ok).toBe(false);
    expect(checkMediaFile(file('noext', 'audio/mpeg')).ok).toBe(false);
    expect(checkMediaFile(file('a.mp3.exe', 'audio/mpeg')).ok).toBe(false);
  });

  it('enforces size bounds', () => {
    expect(checkMediaFile(file('a.mp3', 'audio/mpeg', 0)).ok).toBe(false);
    expect(checkMediaFile(file('a.mp3', 'audio/mpeg', MAX_MEDIA_BYTES)).ok).toBe(true);
    const big = checkMediaFile(file('a.mp3', 'audio/mpeg', MAX_MEDIA_BYTES + 1));
    expect(big).toEqual({ ok: false, error: 'Media files can be at most 300 MB.' });
  });
});

describe('checkCaptionsFile', () => {
  it('accepts .vtt/.srt with the MIME types browsers actually send', () => {
    for (const type of ['', 'text/vtt', 'text/plain', 'application/x-subrip', 'application/octet-stream']) {
      expect(checkCaptionsFile(file('c.vtt', type)).ok).toBe(true);
    }
    expect(checkCaptionsFile(file('C.SRT', ''))).toEqual({ ok: true, value: '.srt' });
  });
  it('rejects other extensions, non-text types and oversize files', () => {
    expect(checkCaptionsFile(file('c.txt', 'text/plain')).ok).toBe(false);
    expect(checkCaptionsFile(file('c.vtt', 'application/x-msdownload')).ok).toBe(false);
    expect(checkCaptionsFile(file('c.vtt', 'text/vtt', MAX_CAPTIONS_BYTES)).ok).toBe(true);
    expect(checkCaptionsFile(file('c.vtt', 'text/vtt', MAX_CAPTIONS_BYTES + 1)).ok).toBe(false);
  });
});

describe('sniffContainer (magic bytes)', () => {
  const bytes = (...parts: Array<string | number[]>) =>
    new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
  it('identifies each allowed container', () => {
    expect(sniffContainer(bytes('RIFF', [0, 0, 0, 0], 'WAVE', 'fmt '))).toBe('wav');
    expect(sniffContainer(bytes([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('webm');
    expect(sniffContainer(bytes([0, 0, 0, 0x20], 'ftypisom'))).toBe('mp4');
    expect(sniffContainer(bytes('ID3', [4, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('mp3');
    expect(sniffContainer(bytes([0xff, 0xfb, 0x90, 0x64]))).toBe('mp3');
  });
  it('rejects anything else', () => {
    expect(sniffContainer(bytes('MZ', [0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0]))).toBeNull();
    expect(sniffContainer(bytes('<html><body>'))).toBeNull();
    expect(sniffContainer(bytes('RIFF', [0, 0, 0, 0], 'AVI '))).toBeNull();
    expect(sniffContainer(new Uint8Array())).toBeNull();
  });
});

describe('names and titles', () => {
  it('extensionOf ignores directories and is case-insensitive', () => {
    expect(extensionOf('../../etc/passwd')).toBe('');
    expect(extensionOf('C:\\Users\\me\\Lecture.MP3')).toBe('.mp3');
    expect(extensionOf('.hidden')).toBe('');
    expect(extensionOf('a.tar.gz')).toBe('.gz');
  });

  it('storage names are server-generated UUIDs; path tricks never pass', () => {
    const name = storedFileName('.wav');
    expect(name).toMatch(/^[0-9a-f-]{36}\.wav$/);
    expect(isStoredFileName(name)).toBe(true);
    expect(storedFileName('.mp4', 'ABCDEF01-2345-4678-9abc-def012345678')).toBe('abcdef01-2345-4678-9abc-def012345678.mp4');
    for (const bad of ['../x.wav', 'a/b.wav', 'lecture.wav', `${name}/..`, `${name}.exe`, `x${name}`, '']) {
      expect(isStoredFileName(bad)).toBe(false);
    }
    expect(() => storedFileName('.wav', '../../evil')).toThrow();
  });

  it('sanitizeTitle strips control characters, collapses whitespace and caps length', () => {
    expect(sanitizeTitle('  Calc\u0000 I\n\t—  chain rule\u202e ')).toBe('Calc I — chain rule');
    expect(sanitizeTitle('x'.repeat(500))).toHaveLength(200);
    expect(sanitizeTitle('   ')).toBe('Untitled lecture');
    expect(sanitizeTitle(42, 'fallback')).toBe('fallback');
  });

  it('titleFromFileName makes a readable default', () => {
    expect(titleFromFileName('/tmp/chain_rule-lecture.mp4')).toBe('chain rule lecture');
    expect(titleFromFileName('.mp3')).toBe('');
  });
});

describe('parseDurationMs', () => {
  it('accepts positive finite numbers (as form strings)', () => {
    expect(parseDurationMs('40000')).toEqual({ ok: true, value: 40000 });
    expect(parseDurationMs('1234.6')).toEqual({ ok: true, value: 1235 });
    expect(parseDurationMs(5000)).toEqual({ ok: true, value: 5000 });
  });
  it('rejects missing, non-finite, non-positive and absurd values', () => {
    for (const bad of [null, undefined, '', 'abc', 'NaN', 'Infinity', '-5', '0', 0, Infinity, '1e12', {}]) {
      expect(parseDurationMs(bad).ok).toBe(false);
    }
  });
});

describe('parseRange', () => {
  const size = 1000;
  it('serves the whole file without a (usable) Range header', () => {
    expect(parseRange(null, size)).toEqual({ kind: 'full' });
    expect(parseRange('', size)).toEqual({ kind: 'full' });
    expect(parseRange('items=0-5', size)).toEqual({ kind: 'full' });
    expect(parseRange('bytes=0-1,5-9', size)).toEqual({ kind: 'full' });
  });
  it('parses closed, open-ended and suffix ranges', () => {
    expect(parseRange('bytes=0-99', size)).toEqual({ kind: 'partial', start: 0, end: 99 });
    expect(parseRange('bytes=500-', size)).toEqual({ kind: 'partial', start: 500, end: 999 });
    expect(parseRange('bytes=-100', size)).toEqual({ kind: 'partial', start: 900, end: 999 });
    expect(parseRange('bytes=-5000', size)).toEqual({ kind: 'partial', start: 0, end: 999 });
    expect(parseRange('bytes=0-', size)).toEqual({ kind: 'partial', start: 0, end: 999 });
    expect(parseRange('Bytes = 10 - 20', size)).toEqual({ kind: 'partial', start: 10, end: 20 });
  });
  it('clamps an end past the file', () => {
    expect(parseRange('bytes=900-5000', size)).toEqual({ kind: 'partial', start: 900, end: 999 });
    expect(parseRange('bytes=0-99999999999999999999', size)).toEqual({ kind: 'partial', start: 0, end: 999 });
  });
  it('flags unsatisfiable or malformed byte ranges', () => {
    for (const bad of ['bytes=1000-', 'bytes=5000-6000', 'bytes=50-10', 'bytes=-0', 'bytes=-', 'bytes=abc', 'bytes=1-2-3']) {
      expect(parseRange(bad, size)).toEqual({ kind: 'unsatisfiable' });
    }
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
  });
});
