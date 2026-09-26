import { describe, expect, it } from 'vitest';
import {
  MAX_PDF_BYTES,
  checkPdfFile,
  contentDisposition,
  countPdfPages,
  describePdfError,
  isPdfHeader,
  isStoredPdfName,
  notabilityFileUrl,
  sanitizePdfDisplayName,
  storedPdfName,
} from '../notability';

const file = (name: string, type: string, size = 1000) => ({ name, type, size });
const bytes = (s: string) => new TextEncoder().encode(s);

describe('checkPdfFile (allowlist: .pdf + application/pdf + size)', () => {
  it('accepts a PDF export', () => {
    expect(checkPdfFile(file('Chain rule.pdf', 'application/pdf'))).toEqual({ ok: true, value: '.pdf' });
    expect(checkPdfFile(file('NOTES.PDF', 'application/pdf'))).toMatchObject({ ok: true });
    expect(checkPdfFile(file('a.pdf', 'Application/PDF; charset=binary'))).toMatchObject({ ok: true });
  });

  it('rejects other extensions, even with a PDF type', () => {
    expect(checkPdfFile(file('notes.txt', 'application/pdf'))).toMatchObject({ ok: false });
    expect(checkPdfFile(file('notes', 'application/pdf'))).toMatchObject({ ok: false });
    expect(checkPdfFile(file('notes.pdf.exe', 'application/pdf'))).toMatchObject({ ok: false });
    expect(checkPdfFile(file('notes.note', 'application/octet-stream'))).toMatchObject({ ok: false });
  });

  it('rejects a .pdf whose declared type is not application/pdf', () => {
    expect(checkPdfFile(file('notes.pdf', 'text/plain'))).toMatchObject({ ok: false });
    expect(checkPdfFile(file('notes.pdf', ''))).toMatchObject({ ok: false });
    expect(checkPdfFile(file('notes.pdf', 'text/html'))).toMatchObject({ ok: false });
  });

  it('rejects empty and oversized files with a readable message', () => {
    expect(checkPdfFile(file('a.pdf', 'application/pdf', 0))).toEqual({ ok: false, error: 'The PDF is empty.' });
    const big = checkPdfFile(file('a.pdf', 'application/pdf', MAX_PDF_BYTES + 1));
    expect(big).toEqual({ ok: false, error: 'PDFs can be at most 50 MB.' });
    expect(checkPdfFile(file('a.pdf', 'application/pdf', MAX_PDF_BYTES))).toMatchObject({ ok: true });
    expect(checkPdfFile(file('a.pdf', 'application/pdf', Number.NaN))).toMatchObject({ ok: false });
  });
});

describe('isPdfHeader (magic bytes)', () => {
  it('needs "%PDF-" at the very start', () => {
    expect(isPdfHeader(bytes('%PDF-1.7\n%âãÏÓ'))).toBe(true);
    expect(isPdfHeader(bytes('%PDF-2.0'))).toBe(true);
    expect(isPdfHeader(bytes('%PDF-'))).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isPdfHeader(bytes('%PDF'))).toBe(false);
    expect(isPdfHeader(bytes(' %PDF-1.7'))).toBe(false);
    expect(isPdfHeader(bytes('%pdf-1.7'))).toBe(false);
    expect(isPdfHeader(bytes('Hello, these are my notes'))).toBe(false);
    expect(isPdfHeader(new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0]))).toBe(false);
    expect(isPdfHeader(new Uint8Array())).toBe(false);
  });
});

describe('sanitizePdfDisplayName (UI only, never a path)', () => {
  it('keeps a normal name', () => {
    expect(sanitizePdfDisplayName('Chain rule — Sep 25.pdf')).toBe('Chain rule — Sep 25.pdf');
  });

  it('drops directories and control / bidi characters, collapses whitespace', () => {
    expect(sanitizePdfDisplayName('../../etc/passwd.pdf')).toBe('passwd.pdf');
    expect(sanitizePdfDisplayName('C:\\Users\\me\\notes.pdf')).toBe('notes.pdf');
    expect(sanitizePdfDisplayName('evil\u202Efdp.exe.pdf')).toBe('evil fdp.exe.pdf');
    expect(sanitizePdfDisplayName('a\u0000b\n\tc   d.pdf')).toBe('a b c d.pdf');
  });

  it('caps the length but keeps the .pdf ending', () => {
    const out = sanitizePdfDisplayName(`${'x'.repeat(500)}.pdf`);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('.pdf')).toBe(true);
  });

  it('falls back for empty / non-string names', () => {
    expect(sanitizePdfDisplayName('')).toBe('Notability export.pdf');
    expect(sanitizePdfDisplayName('   ')).toBe('Notability export.pdf');
    expect(sanitizePdfDisplayName(undefined)).toBe('Notability export.pdf');
    expect(sanitizePdfDisplayName(42)).toBe('Notability export.pdf');
    expect(sanitizePdfDisplayName('/')).toBe('Notability export.pdf');
  });
});

describe('contentDisposition', () => {
  it('is inline with an ASCII fallback and an RFC 5987 UTF-8 name', () => {
    expect(contentDisposition('notes.pdf')).toBe(`inline; filename="notes.pdf"; filename*=UTF-8''notes.pdf`);
    expect(contentDisposition('Chain rule — Sep 25.pdf')).toBe(
      `inline; filename="Chain rule _ Sep 25.pdf"; filename*=UTF-8''Chain%20rule%20%E2%80%94%20Sep%2025.pdf`,
    );
  });

  it('cannot be broken out of (quotes, backslashes, CR/LF, semicolons)', () => {
    for (const name of ['a"; filename=evil.html\r\nX-Evil: 1;%.pdf', 'x\\"; y.pdf', '"";\\;.pdf']) {
      const header = contentDisposition(name);
      expect(header).not.toMatch(/[\r\n]/);
      const ascii = /^inline; filename="([^"]*)"; filename\*=/.exec(header)![1];
      expect(ascii).not.toMatch(/["\\;%]/);
      expect(header).toMatch(/filename\*=UTF-8''[A-Za-z0-9%._~!*'()-]+$/);
    }
  });
});

describe('stored PDF names', () => {
  it('are a server UUID plus .pdf', () => {
    const name = storedPdfName('0F8FAD5B-D9CB-469F-A165-70867728950E');
    expect(name).toBe('0f8fad5b-d9cb-469f-a165-70867728950e.pdf');
    expect(isStoredPdfName(name)).toBe(true);
    expect(isStoredPdfName(storedPdfName())).toBe(true);
  });

  it('never accept client-shaped names', () => {
    expect(() => storedPdfName('../x')).toThrow();
    expect(isStoredPdfName('notes.pdf')).toBe(false);
    expect(isStoredPdfName('../0f8fad5b-d9cb-469f-a165-70867728950e.pdf')).toBe(false);
    expect(isStoredPdfName('0f8fad5b-d9cb-469f-a165-70867728950e.wav')).toBe(false);
    expect(isStoredPdfName('0f8fad5b-d9cb-469f-a165-70867728950e.pdf\0')).toBe(false);
  });
});

describe('countPdfPages (best effort, null when unsure)', () => {
  const simple = (pages: number) =>
    [
      '%PDF-1.7',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      `2 0 obj << /Type /Pages /Kids [] /Count ${pages} >> endobj`,
      ...Array.from({ length: pages }, (_, i) => `${3 + i} 0 obj << /Type /Page /Parent 2 0 R >> endobj`),
      'trailer << /Root 1 0 R >>',
      '%%EOF',
    ].join('\n');

  it('counts page objects in a plain, single-revision file', () => {
    expect(countPdfPages(simple(1))).toBe(1);
    expect(countPdfPages(simple(3))).toBe(3);
    expect(countPdfPages(simple(2).replace(/\/Type \/Page /g, '/Type/Page\n'))).toBe(2);
  });

  it('gives up when pages may be hidden or double counted', () => {
    // Compressed object streams hide page dictionaries.
    expect(countPdfPages(`${simple(2)}\n4 0 obj << /Type /ObjStm /N 3 >> endobj`)).toBeNull();
    // Incremental updates can repeat a page object.
    expect(countPdfPages(`${simple(2)}\n3 0 obj << /Type /Page /Parent 2 0 R >> endobj\n%%EOF`)).toBeNull();
    // Nothing recognisable.
    expect(countPdfPages('%PDF-1.4 garbage')).toBeNull();
  });
});

describe('describePdfError', () => {
  it('explains password-protected files', () => {
    const e = Object.assign(new Error('No password given'), { name: 'PasswordException' });
    expect(describePdfError(e)).toMatchObject({ kind: 'password' });
    expect(describePdfError(e).message).toMatch(/password/i);
  });

  it('explains damaged files', () => {
    const e = Object.assign(new Error('Invalid PDF structure.'), { name: 'InvalidPDFException' });
    expect(describePdfError(e)).toMatchObject({ kind: 'invalid' });
    expect(describePdfError(e).message).toMatch(/damaged|couldn.t be read/i);
  });

  it('explains a failed download', () => {
    const e = Object.assign(new Error('404'), { name: 'ResponseException' });
    expect(describePdfError(e)).toMatchObject({ kind: 'missing' });
  });

  it('never leaks raw error text for anything else', () => {
    const out = describePdfError(new TypeError('secret internal detail'));
    expect(out.kind).toBe('unknown');
    expect(out.message).not.toContain('secret');
    expect(describePdfError(null).kind).toBe('unknown');
    expect(describePdfError('boom').kind).toBe('unknown');
  });
});

describe('notabilityFileUrl', () => {
  it('encodes the session and versions the URL by import id', () => {
    expect(notabilityFileUrl('s_1', 'n_2')).toBe('/api/sessions/s_1/notability/file?v=n_2');
    expect(notabilityFileUrl('a/b', 'c&d')).toBe('/api/sessions/a%2Fb/notability/file?v=c%26d');
  });
});
