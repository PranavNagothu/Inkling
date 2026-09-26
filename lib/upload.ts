// Lecture upload validation (pure; used by the upload form and POST /api/lectures).
// Everything is allowlist-based: extension AND declared MIME AND magic bytes must agree.
import type { LectureMediaType } from './types';

export const MAX_MEDIA_BYTES = 300 * 1024 * 1024;
export const MAX_CAPTIONS_BYTES = 2 * 1024 * 1024;
/** Whole multipart body: both files plus a little room for boundaries and text fields. */
export const MAX_UPLOAD_BYTES = MAX_MEDIA_BYTES + MAX_CAPTIONS_BYTES + 256 * 1024;
export const MAX_TITLE_LEN = 200;
/** Six hours: anything longer is almost certainly a bad duration reading. */
export const MAX_DURATION_MS = 6 * 60 * 60 * 1000;

export type MediaExt = '.mp3' | '.m4a' | '.wav' | '.webm' | '.mp4';
export type Container = 'mp3' | 'mp4' | 'wav' | 'webm';

interface MediaRule {
  container: Container;
  /** Declared MIME → media kind. */
  mimes: Record<string, LectureMediaType>;
  /** MIME we serve the file with, per kind. */
  canonical: Partial<Record<LectureMediaType, string>>;
}

export const MEDIA_RULES: Record<MediaExt, MediaRule> = {
  '.mp3': {
    container: 'mp3',
    mimes: { 'audio/mpeg': 'audio', 'audio/mp3': 'audio', 'audio/mpeg3': 'audio', 'audio/x-mpeg-3': 'audio' },
    canonical: { audio: 'audio/mpeg' },
  },
  '.m4a': {
    container: 'mp4',
    mimes: { 'audio/mp4': 'audio', 'audio/x-m4a': 'audio', 'audio/m4a': 'audio', 'audio/aac': 'audio' },
    canonical: { audio: 'audio/mp4' },
  },
  '.wav': {
    container: 'wav',
    mimes: { 'audio/wav': 'audio', 'audio/x-wav': 'audio', 'audio/wave': 'audio', 'audio/vnd.wave': 'audio' },
    canonical: { audio: 'audio/wav' },
  },
  '.webm': {
    container: 'webm',
    mimes: { 'audio/webm': 'audio', 'video/webm': 'video' },
    canonical: { audio: 'audio/webm', video: 'video/webm' },
  },
  '.mp4': {
    container: 'mp4',
    mimes: { 'video/mp4': 'video', 'audio/mp4': 'audio' },
    canonical: { audio: 'audio/mp4', video: 'video/mp4' },
  },
};

export const CAPTION_EXTS = ['.vtt', '.srt'] as const;
export type CaptionExt = (typeof CAPTION_EXTS)[number];
/** Browsers report caption MIME types inconsistently (often ""), so the content is checked instead. */
const CAPTION_MIMES = new Set(['', 'text/vtt', 'text/plain', 'application/x-subrip', 'text/srt', 'application/octet-stream']);

/** `accept` attribute for the media input. */
export const MEDIA_ACCEPT = [
  ...Object.keys(MEDIA_RULES),
  ...new Set(Object.values(MEDIA_RULES).flatMap((r) => Object.keys(r.mimes))),
].join(',');
export const CAPTIONS_ACCEPT = '.vtt,.srt,text/vtt,application/x-subrip';

/** Lower-cased extension of a client file name ("" if none). Only used for validation, never paths. */
export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface MediaCheck {
  ext: MediaExt;
  mediaType: LectureMediaType;
  mime: string;
  container: Container;
}

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** Name + declared type + size check for the lecture media file. */
export function checkMediaFile(file: { name: string; type: string; size: number }): Result<MediaCheck> {
  const ext = extensionOf(file.name);
  if (!(ext in MEDIA_RULES)) {
    return { ok: false, error: 'Unsupported file type. Use MP3, M4A, WAV, WebM or MP4.' };
  }
  const rule = MEDIA_RULES[ext as MediaExt];
  const declared = file.type.toLowerCase().split(';')[0].trim();
  const mediaType = rule.mimes[declared];
  if (!mediaType) return { ok: false, error: `The file's type (${declared || 'unknown'}) doesn't match ${ext}.` };
  if (!Number.isFinite(file.size) || file.size <= 0) return { ok: false, error: 'The media file is empty.' };
  if (file.size > MAX_MEDIA_BYTES) return { ok: false, error: `Media files can be at most ${mb(MAX_MEDIA_BYTES)}.` };
  return {
    ok: true,
    value: { ext: ext as MediaExt, mediaType, mime: rule.canonical[mediaType]!, container: rule.container },
  };
}

export function checkCaptionsFile(file: { name: string; type: string; size: number }): Result<CaptionExt> {
  const ext = extensionOf(file.name);
  if (!(CAPTION_EXTS as readonly string[]).includes(ext)) {
    return { ok: false, error: 'Captions must be a .vtt or .srt file.' };
  }
  const declared = file.type.toLowerCase().split(';')[0].trim();
  if (!CAPTION_MIMES.has(declared)) return { ok: false, error: `The captions file's type (${declared}) isn't text.` };
  if (file.size > MAX_CAPTIONS_BYTES) {
    return { ok: false, error: `Captions files can be at most ${mb(MAX_CAPTIONS_BYTES)}.` };
  }
  return { ok: true, value: ext as CaptionExt };
}

/** Identifies the container from its first bytes (needs >= 12). */
export function sniffContainer(head: Uint8Array): Container | null {
  const ascii = (from: number, len: number) => String.fromCharCode(...head.subarray(from, from + len));
  if (head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'wav';
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm';
  if (head.length >= 8 && ascii(4, 4) === 'ftyp') return 'mp4';
  if (head.length >= 3 && ascii(0, 3) === 'ID3') return 'mp3';
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'mp3';
  return null;
}

/** Duration reported by the client's media element: finite, positive and sane. */
export function parseDurationMs(raw: unknown): Result<number> {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'Could not read the media length.' };
  if (n > MAX_DURATION_MS) return { ok: false, error: 'Lectures can be at most 6 hours long.' };
  return { ok: true, value: Math.round(n) };
}

/** Display title: control characters stripped, whitespace collapsed, length capped. */
export function sanitizeTitle(raw: unknown, fallback = 'Untitled lecture'): string {
  if (typeof raw !== 'string') return fallback;
  const clean = raw.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.slice(0, MAX_TITLE_LEN).trim() || fallback;
}

/** A readable default title from a client file name ("chain_rule-lecture.mp4" → "chain rule lecture"). */
export function titleFromFileName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/\.[^.]*$/, '');
  return sanitizeTitle(base.replace(/[_-]+/g, ' '), '');
}

const STORED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp3|m4a|wav|webm|mp4)$/;

/** Server-generated storage name; the client's file name is never used on disk. */
export function storedFileName(ext: MediaExt, uuid: string = crypto.randomUUID()): string {
  const name = `${uuid.toLowerCase()}${ext}`;
  if (!STORED_NAME.test(name)) throw new Error('bad storage name');
  return name;
}

export function isStoredFileName(name: string): boolean {
  return STORED_NAME.test(name);
}
