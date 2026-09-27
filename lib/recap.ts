// The spoken session recap: a short (≤ 90 words), encouraging summary of one session built from
// its timeline — how many corrections, gaps and breakthroughs (counted exactly like the review
// header), the concept(s) that came up most, and the one thing to review next. Pure and
// deterministic: DEMO_MODE and every fallback use it as is; with an AI provider the service may
// translate it into another language (lib/ai/service → recap). Concept labels and titles come from
// transcripts, uploads or a model, so they are cleaned and capped before they are spoken.
import type { LanguageCode } from './ai/languages';
import type { CheckAttempt, TimelineEvent } from './types';

export const MAX_RECAP_WORDS = 90;

export type RecapEvent = Pick<TimelineEvent, 'type' | 'status' | 'lectureMs'> & {
  conceptLabel?: string | null;
  checkAttempts: Array<Pick<CheckAttempt, 'correct'>>;
};

export interface RecapInput {
  /** Lecture title (untrusted). */
  title: string;
  events: RecapEvent[];
}

export interface RecapCounts {
  corrections: number;
  gaps: number;
  openGaps: number;
  breakthroughs: number;
}

/** What POST /api/sessions/[id]/recap returns (client-safe). */
export interface RecapPayload {
  text: string;
  /** The language `text` is in. */
  language: LanguageCode;
  /** 'template': built here; 'ai': translated by the AI provider. */
  source: 'template' | 'ai';
  /** Another language was asked for, but the recap is in English. */
  languageFallback?: boolean;
  /** POST endpoint for the server voice's mp3 (absent: speak it in the browser). */
  audioUrl?: string;
  /** Which server voice ("ElevenLabs", …). */
  voice?: string;
}

export interface BuiltRecap {
  text: string;
  /** The template's language: `language` when there is a template for it, else 'en'. */
  language: LanguageCode;
  counts: RecapCounts;
  /** The concept to review next, or null when nothing is left open. */
  focus: string | null;
}

/** Controls, bidi overrides, zero-width characters (never spoken or shown). */
const HIDDEN = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g;

function clean(value: string | null | undefined, maxChars: number): string {
  const t = (value ?? '').replace(/\s+/g, ' ').replace(HIDDEN, '').replace(/ {2,}/g, ' ').trim();
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, maxChars);
  const space = cut.lastIndexOf(' ');
  return (space > maxChars / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '');
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export function recapCounts(events: RecapEvent[]): RecapCounts {
  const of = (type: RecapEvent['type']) => events.filter((e) => e.type === type);
  return {
    corrections: of('misconception_corrected').length,
    gaps: of('unresolved_gap').length,
    openGaps: of('unresolved_gap').filter((e) => e.status === 'open').length,
    breakthroughs: of('breakthrough').length,
  };
}

interface Phrases {
  momentAt: (clock: string) => string;
  empty: (title: string) => string;
  intro: (title: string) => string;
  counts: (c: RecapCounts) => string;
  topics: (labels: string[]) => string;
  reviewGap: (label: string) => string;
  reviewCorrection: (label: string) => string;
  allDone: (label: string | null) => string;
  close: (breakthroughs: number) => string;
  fallbackTitle: string;
}

const list = (items: string[], and: string) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} ${and} ${items[items.length - 1]}`;

const EN: Phrases = {
  fallbackTitle: 'this session',
  momentAt: (c) => `the moment at ${c}`,
  empty: (t) =>
    `Here’s your recap of ${t}. No corrections, gaps or breakthroughs showed up yet. Keep writing as you listen, and your next recap will show you what to review.`,
  intro: (t) => `Here’s your recap of ${t}.`,
  counts: ({ corrections: c, gaps: g, breakthroughs: b }) => {
    const n = (k: number, one: string, many: string) => (k === 0 ? `no ${many}` : `${k} ${k === 1 ? one : many}`);
    return `You worked through ${list([n(c, 'correction', 'corrections'), n(g, 'gap', 'gaps'), n(b, 'breakthrough', 'breakthroughs')], 'and')}.`;
  },
  topics: (l) => `Most of it was about ${list(l, 'and')}.`,
  reviewGap: (l) => `Next, review ${l}: replay that part and try the check question.`,
  reviewCorrection: (l) => `Next, try the check question on ${l} to lock in your fix.`,
  allDone: (l) => (l ? `Nothing is left open, so a quick look at ${l} will keep it fresh.` : 'Nothing is left open.'),
  close: (b) =>
    b === 0
      ? 'Every correction is progress. You’ve got this!'
      : b === 1
        ? 'Your breakthrough shows the fixes are sticking. Keep going!'
        : 'Your breakthroughs show the fixes are sticking. Keep going!',
};

const ES: Phrases = {
  fallbackTitle: 'esta sesión',
  momentAt: (c) => `el momento ${c}`,
  empty: (t) =>
    `Este es tu resumen de ${t}. Todavía no hay correcciones, dudas ni avances. Sigue escribiendo mientras escuchas y tu próximo resumen te dirá qué repasar.`,
  intro: (t) => `Este es tu resumen de ${t}.`,
  counts: ({ corrections: c, gaps: g, breakthroughs: b }) => {
    const n = (k: number, one: string, many: string, none: string) => (k === 0 ? none : `${k} ${k === 1 ? one : many}`);
    return `Trabajaste ${list(
      [n(c, 'corrección', 'correcciones', 'ninguna corrección'), n(g, 'duda', 'dudas', 'ninguna duda'), n(b, 'avance', 'avances', 'ningún avance')],
      'y',
    )}.`;
  },
  topics: (l) => (l.length === 1 ? `El tema principal fue ${l[0]}.` : `Los temas principales fueron ${list(l, 'y')}.`),
  reviewGap: (l) => `Ahora repasa ${l}: vuelve a escuchar esa parte y responde la pregunta de comprobación.`,
  reviewCorrection: (l) => `Ahora responde la pregunta de comprobación sobre ${l} para afianzar tu corrección.`,
  allDone: (l) => (l ? `No queda nada pendiente, así que un repaso rápido de ${l} lo mantendrá fresco.` : 'No queda nada pendiente.'),
  close: (b) =>
    b === 0
      ? 'Cada corrección es un progreso. ¡Tú puedes!'
      : b === 1
        ? 'Tu avance muestra que las correcciones funcionan. ¡Sigue así!'
        : 'Tus avances muestran que las correcciones funcionan. ¡Sigue así!',
};

const HI: Phrases = {
  fallbackTitle: 'इस सत्र',
  momentAt: (c) => `${c} वाला हिस्सा`,
  empty: (t) =>
    `यह ${t} का आपका सारांश है। अभी तक कोई सुधार, अधूरा सवाल या बड़ी सफलता नहीं दिखी। सुनते हुए लिखते रहिए, अगला सारांश बताएगा कि क्या दोहराना है।`,
  intro: (t) => `यह ${t} का आपका सारांश है।`,
  counts: ({ corrections: c, gaps: g, breakthroughs: b }) =>
    `इस सत्र में: ${list([`${c} सुधार`, `${g} ${g === 1 ? 'अधूरा सवाल' : 'अधूरे सवाल'}`, `${b} ${b === 1 ? 'बड़ी सफलता' : 'बड़ी सफलताएँ'}`], 'और')}।`,
  topics: (l) => `सबसे ज़्यादा बात ${list(l, 'और')} पर हुई।`,
  reviewGap: (l) => `अब ${l} दोहराइए: वह हिस्सा फिर से सुनिए और जाँच वाला सवाल हल कीजिए।`,
  reviewCorrection: (l) => `अब ${l} पर जाँच वाला सवाल हल कीजिए, ताकि आपका सुधार पक्का हो जाए।`,
  allDone: (l) => (l ? `कुछ भी बाकी नहीं है, इसलिए ${l} पर एक छोटी नज़र इसे ताज़ा रखेगी।` : 'कुछ भी बाकी नहीं है।'),
  close: (b) => (b === 0 ? 'हर सुधार एक कदम आगे है। आप यह कर सकते हैं!' : 'आपकी सफलता दिखाती है कि सुधार टिक रहे हैं। ऐसे ही आगे बढ़ते रहिए!'),
};

const TEMPLATES: Partial<Record<LanguageCode, Phrases>> = { en: EN, es: ES, hi: HI };

/** Languages with a hand-written template (the others are English, translated by the service). */
export const RECAP_TEMPLATE_LANGUAGES = Object.keys(TEMPLATES) as LanguageCode[];

/** Up to `max` labels, most frequent first (ties: earliest in the lecture). */
function topLabels(events: RecapEvent[], name: (e: RecapEvent) => string, max: number): string[] {
  const seen = new Map<string, { n: number; first: number }>();
  for (const e of events) {
    const l = name(e);
    const cur = seen.get(l);
    if (cur) cur.n++;
    else seen.set(l, { n: 1, first: e.lectureMs });
  }
  return [...seen.entries()]
    .sort(([, a], [, b]) => b.n - a.n || a.first - b.first)
    .slice(0, max)
    .map(([l]) => l);
}

/** Keeps whole sentences within the word budget (a sentence that doesn't fit is dropped). */
function withinWords(sentences: string[], max: number): string {
  const out: string[] = [];
  let used = 0;
  for (const s of sentences) {
    const n = s.split(/\s+/).filter(Boolean).length;
    if (used + n > max) continue;
    out.push(s);
    used += n;
  }
  return out.join(' ');
}

export function buildRecap(input: RecapInput, language: LanguageCode): BuiltRecap {
  const template = TEMPLATES[language];
  const lang: LanguageCode = template ? language : 'en';
  const p = template ?? EN;
  const counts = recapCounts(input.events);
  const title = clean(input.title, 60) || p.fallbackTitle;
  const events = [...input.events].sort((a, b) => a.lectureMs - b.lectureMs);
  if (events.length === 0) return { text: withinWords([p.empty(title)], MAX_RECAP_WORDS), language: lang, counts, focus: null };

  const name = (e: RecapEvent) => clean(e.conceptLabel, 48) || p.momentAt(clock(e.lectureMs));
  const top = topLabels(events, name, 2);
  const openGap = events.find((e) => e.type === 'unresolved_gap' && e.status === 'open');
  // A correction whose check question hasn't been answered correctly yet (a breakthrough has).
  const unconfirmed = events.find((e) => e.type === 'misconception_corrected' && !e.checkAttempts.some((a) => a.correct));
  const focus = openGap ? name(openGap) : unconfirmed ? name(unconfirmed) : null;
  const next = openGap ? p.reviewGap(focus!) : unconfirmed ? p.reviewCorrection(focus!) : p.allDone(top[0] ?? null);

  // Intro, counts, next step and the close always fit; the topic sentence is the one that may go.
  const text = withinWords([p.intro(title), p.counts(counts), p.topics(top), next, p.close(counts.breakthroughs)], MAX_RECAP_WORDS);
  return { text, language: lang, counts, focus };
}
