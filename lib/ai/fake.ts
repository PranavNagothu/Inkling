import "server-only";

// Deterministic offline provider (AI_PROVIDER=fake; also the offline fallback in DEMO_MODE).
// Every output is derived from its input by hashing, so tests are repeatable and the same moment
// always gets the same card. Never touches the network.
import type { RevisionReading } from '../types';
import { normalizeForKey, sha256, stableStringify } from './cache';
import type { LanguageCode } from './languages';
import { cleanUntrusted } from './prompts';
import type { AiProvider, CallOptions, HelpCardCore, HelpContext, RevisionInput } from './types';
import { truncateWords } from './validate';

export const FAKE_MODEL = 'fake-1';

const STOP = new Set(
  'about after again also another because before being could does doing from have here into just like looking more most next only other over please really same should some such than that their them then there these they this those through today under very want what when where which while will with would your okay alright let lets'.split(
    ' ',
  ),
);

const hashOf = (value: unknown) => sha256(stableStringify(normalizeForKey(value)));

function checkAbort(opts?: CallOptions) {
  if (opts?.signal?.aborted) throw opts.signal.reason ?? new Error('aborted');
}

const firstWords = (text: string, n: number) => truncateWords(cleanUntrusted(text, 400), n).replace(/…$/, '');

/** 2–3 significant words of the text, sentence-cased ("Outer function inner"). */
export function fakeLabel(text: string): string {
  const words = cleanUntrusted(text, 800)
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP.has(w.replace(/'/g, '')));
  const picked = [...new Set(words)].slice(0, 3);
  while (picked.length < 2) picked.push(picked.length === 0 ? 'lecture' : 'concept');
  const label = picked.join(' ');
  return label[0].toUpperCase() + label.slice(1);
}

const OPTIONS = [
  'Multiply by the derivative of the inside',
  'Stop after the outer derivative',
  'Differentiate only the inside function',
  'Add the outer and inner derivatives',
];

export function createFakeProvider(): AiProvider {
  return {
    name: 'fake',
    model: FAKE_MODEL,
    async helpFor(ctx: HelpContext, opts?: CallOptions): Promise<HelpCardCore> {
      checkAbort(opts);
      const h = hashOf(ctx);
      const answerIdx = parseInt(h.slice(0, 2), 16) % 4;
      const said = firstWords(ctx.excerpt, 24).replace(/[\s.,;:!?…]+$/, '');
      const reexplain = truncateWords(
        `Let’s rebuild this one step at a time.${said ? ` The lecture said: “${said}.”` : ''} Name the outer piece and the inner piece, differentiate the outer one while leaving the inside alone, then multiply by the derivative of the inside.`,
        80,
      );
      // Rotate so the correct option lands at answerIdx.
      const options = OPTIONS.map((_, i) => OPTIONS[(i - answerIdx + 4) % 4]);
      return {
        reexplain,
        mcq: {
          q: 'Quick check: after differentiating the outer function, what finishes a chain-rule derivative?',
          options,
          answerIdx,
          why: 'The outer derivative, taken at the inside, is multiplied by the derivative of the inside. Stopping after the outer derivative drops that factor.',
        },
      };
    },
    async readRevision(input: RevisionInput, opts?: CallOptions): Promise<RevisionReading> {
      checkAbort(opts);
      const said = firstWords(input.excerpt, 6) || 'this step';
      return {
        before: "a first attempt at this step",
        after: "a rewritten version of it",
        misconception: truncateWords(`Mixed up a step while the lecture said “${said}”.`, 25),
        conceptLabel: fakeLabel(input.excerpt),
        cosmetic: false,
      };
    },
    async labelConcept(segmentText: string, opts?: CallOptions): Promise<string> {
      checkAbort(opts);
      return fakeLabel(segmentText);
    },
    // "Translations" are the English text tagged with the language ("[es] …"): deterministic, and
    // easy for tests to see which language was served. Options keep their order and answerIdx.
    async localizeHelp(card: HelpCardCore, language: LanguageCode, opts?: CallOptions): Promise<HelpCardCore> {
      checkAbort(opts);
      const tag = (t: string) => `[${language}] ${t}`;
      return {
        reexplain: tag(card.reexplain),
        mcq: { q: tag(card.mcq.q), options: card.mcq.options.map(tag), answerIdx: card.mcq.answerIdx, why: tag(card.mcq.why) },
      };
    },
    async polishRecap(text: string, language: LanguageCode, opts?: CallOptions): Promise<string> {
      checkAbort(opts);
      return `[${language}] ${text}`;
    },
  };
}
