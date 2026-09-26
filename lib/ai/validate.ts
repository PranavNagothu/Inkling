import "server-only";

// Strict validation (with small, safe repairs) of what a model returns. Model output is untrusted:
// nothing outside the known fields survives, strings are cleaned, limits are enforced. A result
// that can't be repaired is rejected (the provider retries once, then the service falls back).
import type { RevisionReading } from '../types';
import { HIDDEN } from './prompts';
import type { HelpCardCore } from './types';

export type Validated<T> = { ok: true; value: T } | { ok: false; issues: string[] };

export const LIMITS = {
  reexplainWords: 80,
  questionWords: 40,
  optionChars: 160,
  whyWords: 50,
  revisionSideWords: 25,
  misconceptionWords: 25,
  labelMinWords: 2,
  labelMaxWords: 4,
  /** Past this multiple of a word limit the model ignored the brief: reject rather than cut. */
  repairFactor: 1.5,
} as const;

/** Removes control / invisible characters and collapses whitespace. */
export function cleanText(s: string): string {
  return s.replace(HIDDEN, '').replace(/\s+/g, ' ').trim();
}

export function countWords(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

/**
 * Cuts text to at most `max` words, preferring the last sentence end inside the limit; "…" marks a
 * hard cut mid-sentence.
 */
export function truncateWords(s: string, max: number): string {
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length <= max) return words.join(' ');
  const kept = words.slice(0, max);
  for (let i = kept.length - 1; i >= Math.floor(max / 2); i--) {
    if (/[.!?]["')\]]?$/.test(kept[i])) return kept.slice(0, i + 1).join(' ');
  }
  return `${kept.join(' ').replace(/[\s,;:]+$/, '')}…`;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A required, non-empty string within `maxWords` (repaired by cutting when only a little over). */
function text(v: unknown, field: string, maxWords: number, issues: string[], allowEmpty = false): string {
  if (typeof v !== 'string') {
    issues.push(`${field} must be a string`);
    return '';
  }
  const t = cleanText(v);
  if (!t && !allowEmpty) {
    issues.push(`${field} must not be empty`);
    return '';
  }
  const n = countWords(t);
  if (n > maxWords * LIMITS.repairFactor) {
    issues.push(`${field} must be at most ${maxWords} words (got ${n})`);
    return '';
  }
  return n > maxWords ? truncateWords(t, maxWords) : t;
}

function index(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^\s*\d\s*$/.test(v)) return Number(v);
  return null;
}

export function validateHelpCard(raw: unknown): Validated<HelpCardCore> {
  const issues: string[] = [];
  if (!isObj(raw)) return { ok: false, issues: ['answer must be a JSON object'] };
  const reexplain = text(raw.reexplain, 'reexplain', LIMITS.reexplainWords, issues);
  const mcq = raw.mcq;
  if (!isObj(mcq)) return { ok: false, issues: [...issues, 'mcq must be an object'] };
  const q = text(mcq.q, 'mcq.q', LIMITS.questionWords, issues);
  const why = text(mcq.why, 'mcq.why', LIMITS.whyWords, issues);

  let options: string[] = [];
  if (!Array.isArray(mcq.options) || mcq.options.length !== 4) {
    issues.push('mcq.options must have exactly 4 items');
  } else {
    options = mcq.options.map((o, i) => {
      if (typeof o !== 'string') {
        issues.push(`mcq.options[${i}] must be a string`);
        return '';
      }
      const t = cleanText(o);
      if (!t) issues.push(`mcq.options[${i}] must not be empty`);
      else if (t.length > LIMITS.optionChars) issues.push(`mcq.options[${i}] must be at most ${LIMITS.optionChars} characters`);
      return t;
    });
    const distinct = new Set(options.map((o) => o.toLowerCase()));
    if (options.every(Boolean) && distinct.size !== 4) issues.push('mcq.options must be 4 different answers');
  }

  const answerIdx = index(mcq.answerIdx);
  if (answerIdx === null || answerIdx < 0 || answerIdx > 3) issues.push('mcq.answerIdx must be an integer from 0 to 3');

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { reexplain, mcq: { q, options, answerIdx: answerIdx!, why } } };
}

function label(v: unknown, field: string, issues: string[]): string {
  if (typeof v !== 'string') {
    issues.push(`${field} must be a string`);
    return '';
  }
  const t = cleanText(v)
    .replace(/^["'“‘«]+|["'”’»]+$/g, '')
    .replace(/[\s.,;:!?…"'”’-]+$/, '')
    .trim();
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < LIMITS.labelMinWords) {
    issues.push(`${field} must be ${LIMITS.labelMinWords}–${LIMITS.labelMaxWords} words`);
    return '';
  }
  return words.slice(0, LIMITS.labelMaxWords).join(' ').replace(/[\s.,;:!?…-]+$/, '');
}

export function validateRevisionReading(raw: unknown): Validated<RevisionReading> {
  const issues: string[] = [];
  if (!isObj(raw)) return { ok: false, issues: ['answer must be a JSON object'] };
  let cosmetic: boolean | null = null;
  if (typeof raw.cosmetic === 'boolean') cosmetic = raw.cosmetic;
  else if (raw.cosmetic === 'true' || raw.cosmetic === 'false') cosmetic = raw.cosmetic === 'true';
  else issues.push('cosmetic must be true or false');

  const before = text(raw.before, 'before', LIMITS.revisionSideWords, issues);
  const after = text(raw.after, 'after', LIMITS.revisionSideWords, issues);
  // A tidy-up (re-drawing the same thing neater) has no misconception to report.
  const misconception = text(raw.misconception, 'misconception', LIMITS.misconceptionWords, issues, cosmetic === true);
  const conceptLabel = label(raw.conceptLabel, 'conceptLabel', issues);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { before, after, misconception, conceptLabel, cosmetic: cosmetic! } };
}

export function validateConceptLabel(raw: unknown): Validated<string> {
  if (!isObj(raw)) return { ok: false, issues: ['answer must be a JSON object'] };
  const issues: string[] = [];
  const value = label(raw.label, 'label', issues);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}
