// Deterministic "offline" answers: keyword scoring over the knowledge base. Used when there is no
// model key, when the assistant is disabled or over quota, and when the model call fails — so the
// assistant always has something useful (and true) to say.
import { KNOWLEDGE, type KnowledgeEntry } from "../knowledge";

const STOPWORDS = new Set(
  (
    "a an the is are am was were be been being do does did doing i me my mine you your yours we our us it its " +
    "this that these those there here what which who whom whose when where why how can could would should will " +
    "shall may might must to of in on at by for with about as from into over under and or but if then so than " +
    "too very just also any some all each much many more most such not no nor only own same up down out off " +
    "again once have has had having get got tell please want know like thing things one ones whats hows its thats"
  ).split(" "),
);
// "know" and "get" are stopwords in general but meaningful for a couple of entries' keywords;
// keyword matching below runs before the stopword filter for those.
const KEEP_FOR_KEYWORDS = new Set(["know", "get", "one"]);

/** Words that barely distinguish anything on this page. */
const LOW_WEIGHT: Record<string, number> = { inkling: 0.25, app: 0.5, notes: 0.5, work: 0.25, works: 0.25, use: 0.5 };

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’']/g, "")
    .split(/[^a-z0-9≥]+/)
    .filter(Boolean);
}

/** Very light stemming: plural "s", "-ing", "-ed" (enough for keyword lists written by hand). */
export function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

interface Indexed {
  entry: KnowledgeEntry;
  keywords: Set<string>;
  question: Set<string>;
  topic: Set<string>;
}

const INDEX: Indexed[] = KNOWLEDGE.map((entry) => ({
  entry,
  keywords: new Set(entry.keywords.flatMap(tokenize).map(stem)),
  question: new Set(tokenize(entry.question).filter((w) => !STOPWORDS.has(w)).map(stem)),
  topic: new Set(tokenize(entry.topic).filter((w) => !STOPWORDS.has(w)).map(stem)),
}));

export interface FaqMatch {
  entry: KnowledgeEntry;
  score: number;
}

/** Best-scoring entries for a question, highest first (only those above zero). */
export function rankFaq(query: string): FaqMatch[] {
  const words = tokenize(query)
    .filter((w) => !STOPWORDS.has(w) || KEEP_FOR_KEYWORDS.has(w))
    .map(stem);
  const unique = [...new Set(words)];
  if (!unique.length) return [];

  const scored = INDEX.map(({ entry, keywords, question, topic }) => {
    let score = 0;
    for (const w of unique) {
      const weight = LOW_WEIGHT[w] ?? 1;
      if (keywords.has(w)) score += 2 * weight;
      if (!STOPWORDS.has(w)) {
        if (question.has(w)) score += 1.5 * weight;
        if (topic.has(w)) score += 1 * weight;
      }
    }
    return { entry, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
}

/** Minimum score for an offline answer to count as a match. */
export const MIN_FAQ_SCORE = 1.5;

const GREETING = /^(hi|hello|hey|yo|hiya|good (morning|afternoon|evening)|thanks|thank you|thx)\b[\s!.?]*$/i;

export const OFFLINE_NO_MATCH =
  "I don't know that one. I can tell you how Inkling notices when you're stuck, what ghost ink is, which languages it speaks, how it works with Notability, how your data is handled, what teachers see, and how to try it.";

export const OFFLINE_GREETING =
  "Hi! I'm Inkling's assistant. Ask me how Inkling notices when you're stuck, how it works with Notability, how your data is handled, or which languages it supports.";

/** A deterministic answer for any question. */
export function offlineAnswer(query: string): { text: string; entryId: string | null } {
  if (GREETING.test(query.trim())) return { text: OFFLINE_GREETING, entryId: null };
  // "What is Inkling?" / "Tell me about Inkling": nothing but the name left after stopwords.
  const content = tokenize(query).filter((w) => !STOPWORDS.has(w));
  if (content.length && content.every((w) => w === "inkling" || w === "about")) {
    const what = KNOWLEDGE.find((e) => e.id === "what")!;
    return { text: what.answer, entryId: what.id };
  }
  const [best] = rankFaq(query);
  if (!best || best.score < MIN_FAQ_SCORE) return { text: OFFLINE_NO_MATCH, entryId: null };
  return { text: best.entry.answer, entryId: best.entry.id };
}
