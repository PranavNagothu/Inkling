import "server-only";

// DEMO_MODE fixtures (public/demo/ai-cache.json): hand-checked help cards, revision readings and
// concept labels for the bundled demo lecture, keyed by stretches of lecture time so they match
// the demo scenario's moments whatever session they come from. Served offline; nothing here calls
// a model.
import type { HelpCard, RevisionReading } from '../types';
import { parseLanguage, type LanguageCode } from './languages';
import type { HelpCardCore } from './types';
import { validateLocalizedHelpCard } from './validate';

/** A hand-written translation of an entry's card: no answerIdx (the English one grades it). */
export interface DemoTranslation {
  reexplain: string;
  mcq: { q: string; options: string[]; why: string };
}

export interface DemoEntry {
  /** [fromMs, toMs) of the demo lecture. */
  fromMs: number;
  toMs: number;
  label: string;
  help: HelpCardCore;
  revision?: RevisionReading;
  /** Translations of `help` (Spanish and Hindi for the seeded moments). */
  i18n?: Partial<Record<LanguageCode, DemoTranslation>>;
}

export interface DemoFixtures {
  lectureId: string;
  entries: DemoEntry[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Shape check only (content is validated by the unit test with the live validators). */
export function parseDemoFixtures(raw: unknown): DemoFixtures {
  if (!isObj(raw) || typeof raw.lectureId !== 'string' || !Array.isArray(raw.entries)) {
    throw new Error('demo fixtures: expected { lectureId, entries[] }');
  }
  const entries = raw.entries.map((e, i) => {
    if (
      !isObj(e) ||
      typeof e.fromMs !== 'number' ||
      typeof e.toMs !== 'number' ||
      typeof e.label !== 'string' ||
      !isObj(e.help) ||
      (e.revision !== undefined && !isObj(e.revision)) ||
      (e.i18n !== undefined && (!isObj(e.i18n) || !Object.keys(e.i18n).every((k) => parseLanguage(k) && k !== 'en')))
    ) {
      throw new Error(`demo fixtures: entry ${i} is malformed`);
    }
    return e as unknown as DemoEntry;
  });
  return { lectureId: raw.lectureId, entries };
}

export function demoEntryFor(fixtures: DemoFixtures, lectureId: string, lectureMs: number): DemoEntry | null {
  if (lectureId !== fixtures.lectureId) return null;
  return fixtures.entries.find((e) => lectureMs >= e.fromMs && lectureMs < e.toMs) ?? null;
}

export const demoHelpCard = (entry: DemoEntry): HelpCard => ({ ...entry.help, source: 'demo', provider: 'demo' });

/**
 * The entry's card in `language`, checked like a model's translation (4 options in the English
 * order, math intact) and graded by the English answerIdx; null when there is none.
 */
export function demoTranslation(entry: DemoEntry, language: LanguageCode): HelpCardCore | null {
  const t = entry.i18n?.[language];
  if (!t) return null;
  const v = validateLocalizedHelpCard(t, entry.help);
  return v.ok ? v.value : null;
}
