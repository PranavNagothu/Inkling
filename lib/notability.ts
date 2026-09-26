// Notability PDF import: pure validation and naming helpers (client-safe; used by the compare page
// and POST /api/sessions/[id]/notability). Allowlist-based like lecture uploads (./upload): the
// extension AND the declared MIME type AND the magic bytes must all say "PDF".
import { extensionOf, type Result } from './upload';

export const MAX_PDF_BYTES = 50 * 1024 * 1024;
/** Whole multipart body: the file plus room for boundaries. */
export const MAX_PDF_UPLOAD_BYTES = MAX_PDF_BYTES + 64 * 1024;
export const PDF_MIME = 'application/pdf';
/** `accept` attribute for the file input. */
export const PDF_ACCEPT = '.pdf,application/pdf';
export const MAX_DISPLAY_NAME_LEN = 120;
export const DEFAULT_PDF_NAME = 'Notability export.pdf';

/** Name + declared type + size check. Returns the (only) allowed extension. */
export function checkPdfFile(file: { name: string; type: string; size: number }): Result<'.pdf'> {
  if (extensionOf(file.name) !== '.pdf') return { ok: false, error: 'Choose a PDF — export it from Notability as PDF.' };
  const declared = file.type.toLowerCase().split(';')[0].trim();
  if (declared !== PDF_MIME) return { ok: false, error: `That file's type (${declared || 'unknown'}) isn't PDF.` };
  if (!Number.isFinite(file.size) || file.size <= 0) return { ok: false, error: 'The PDF is empty.' };
  if (file.size > MAX_PDF_BYTES) return { ok: false, error: 'PDFs can be at most 50 MB.' };
  return { ok: true, value: '.pdf' };
}

const MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
/** Bytes needed by isPdfHeader. */
export const PDF_HEADER_BYTES = MAGIC.length;

/** True when the bytes start with the PDF signature "%PDF-". */
export function isPdfHeader(head: Uint8Array): boolean {
  return head.length >= MAGIC.length && MAGIC.every((b, i) => head[i] === b);
}

// C0/C1 controls, zero-width and bidi override/isolate characters (which can disguise an extension).
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;

/** A file name fit for display only (never used on disk): no directories, controls or bidi tricks. */
export function sanitizePdfDisplayName(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_PDF_NAME;
  const base = raw.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!clean || clean === '.pdf') return DEFAULT_PDF_NAME;
  if (clean.length <= MAX_DISPLAY_NAME_LEN) return clean;
  const ext = extensionOf(clean) === '.pdf' ? clean.slice(-4) : '';
  return `${clean.slice(0, MAX_DISPLAY_NAME_LEN - ext.length - 1).trimEnd()}…${ext}`;
}

/** RFC 5987 value: percent-encode everything but unreserved characters. */
const encodeRfc5987 = (s: string) =>
  encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * `Content-Disposition: inline` with a quoted ASCII fallback (anything outside safe printable ASCII
 * becomes "_") and the exact name as filename*. Nothing in the name can end the header or the value.
 */
export function contentDisposition(name: string): string {
  const safe = sanitizePdfDisplayName(name);
  const ascii = safe.replace(/[^\x20-\x7e]|["\\;%]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(safe)}`;
}

const STORED_PDF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/;

/** Server-generated storage name; the client's file name is never used on disk. */
export function storedPdfName(uuid: string = crypto.randomUUID()): string {
  const name = `${uuid.toLowerCase()}.pdf`;
  if (!STORED_PDF.test(name)) throw new Error('bad storage name');
  return name;
}

export function isStoredPdfName(name: string): boolean {
  return STORED_PDF.test(name);
}

/**
 * Page count read straight from the file, only when that is exact: a single revision (one %%EOF)
 * without compressed object streams. Anything else — or nothing recognisable — is null (the
 * browser learns the real count from pdf.js).
 */
export function countPdfPages(latin1: string): number | null {
  if (/\/Type\s*\/ObjStm\b/.test(latin1)) return null;
  if ((latin1.match(/%%EOF/g) ?? []).length !== 1) return null;
  const pages = (latin1.match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;
  return pages > 0 ? pages : null;
}

export type PdfErrorKind = 'password' | 'invalid' | 'missing' | 'unknown';

/** A friendly explanation for a PDF that can't be shown (never the raw error text). */
export function describePdfError(err: unknown): { kind: PdfErrorKind; message: string } {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  switch (name) {
    case 'PasswordException':
      return {
        kind: 'password',
        message: 'This PDF is password-protected. Export it from Notability again without a password, then upload that copy.',
      };
    case 'InvalidPDFException':
      return {
        kind: 'invalid',
        message: 'This PDF couldn’t be read — it may be damaged or incomplete. Try exporting it from Notability again.',
      };
    case 'ResponseException':
      return { kind: 'missing', message: 'Couldn’t load the PDF from Inkling. Reload the page to try again.' };
    default:
      return { kind: 'unknown', message: 'Something went wrong showing this PDF. Try uploading it again.' };
  }
}

/** URL of a session's current Notability PDF; versioned by import id so a replacement is refetched. */
export function notabilityFileUrl(sessionId: string, importId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/notability/file?v=${encodeURIComponent(importId)}`;
}
