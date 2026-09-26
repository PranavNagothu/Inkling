// Generates a placeholder word-level transcript for the demo lecture:
// public/demo/lecture.transcript.json (TranscriptWord[] = { w, startMs, endMs }[]).
// Deterministic (seeded PRNG) so re-running produces the same file. Words are spaced ~350–450 ms
// apart with a few natural 1–3 s pauses between sentences, and cover the whole lecture duration
// read from public/demo/lecture.json. Replaced by a real transcript in Phase 4.
// Usage: node scripts/make-demo-transcript.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const demoDir = join(root, "public", "demo");
const { durationMs } = JSON.parse(readFileSync(join(demoDir, "lecture.json"), "utf8"));

const SENTENCES = [
  "Okay everyone, today we are looking at the chain rule.",
  "The chain rule tells us how to differentiate a composition of functions.",
  "So if y equals f of g of x, we have an outer function f and an inner function g.",
  "The derivative is f prime of g of x, times g prime of x.",
  "Notice we evaluate f prime at the inner function, not at x.",
  "That is the part people forget most often.",
  "Let's try an example: y equals the quantity three x plus one, all squared.",
  "The outer function is u squared and the inner function is three x plus one.",
  "The outer derivative is two u, so two times three x plus one.",
  "Then we multiply by the derivative of the inside, which is three.",
  "So the answer is six times three x plus one.",
  "A common mistake is to stop after the outer derivative and forget to multiply by three.",
  "Another way to write it uses Leibniz notation: dy dx equals dy du times du dx.",
  "It looks like the du terms cancel, which is a nice way to remember it.",
  "Let's do sine of x squared.",
  "Outer function sine, inner function x squared.",
  "The derivative is cosine of x squared, times two x.",
  "Be careful: it is cosine of x squared, not cosine of x, times two x.",
  "Now what about e to the five x?",
  "The derivative of e to the u is e to the u, so we get e to the five x times five.",
  "Sometimes there are three layers, like the square root of sine of x squared.",
  "Then we apply the chain rule twice, working from the outside in.",
  "Outer is square root, middle is sine, inner is x squared.",
  "One over two root sine x squared, times cosine x squared, times two x.",
  "Each layer contributes one factor to the product.",
  "If you ever get lost, write down u and v for the inner pieces.",
  "Let's check the power rule case: x squared plus one, to the tenth power.",
  "Ten times x squared plus one to the ninth, times two x.",
  "Please don't expand that to the tenth power first, it takes forever.",
  "The chain rule also explains implicit differentiation, which we will see next week.",
  "When we differentiate y squared with respect to x we get two y times dy dx.",
  "That dy dx factor is the chain rule at work.",
  "Alright, a quick question to check understanding.",
  "What is the derivative of cosine of three x?",
  "It is negative sine of three x, times three.",
  "The negative comes from the derivative of cosine, and the three from the inside.",
  "Let's summarize: identify the outer and inner functions.",
  "Differentiate the outer function, keeping the inner function inside.",
  "Then multiply by the derivative of the inner function.",
  "Now let's compare this with the product rule, because students mix them up.",
  "The product rule is for two functions multiplied together, like x times sine x.",
  "The chain rule is for one function plugged into another, like sine of x squared.",
  "Ask yourself: is the x sitting inside something, or next to something?",
  "Sometimes you need both rules in the same problem.",
  "Take x squared times e to the three x.",
  "Product rule first: two x times e to the three x, plus x squared times the derivative of e to the three x.",
  "And that derivative needs the chain rule: e to the three x times three.",
  "So the full answer is two x e to the three x plus three x squared e to the three x.",
  "You can factor out x e to the three x if you want a cleaner form.",
  "Let's look at a quotient too: one over the quantity x squared plus four.",
  "Rewrite it as x squared plus four to the negative one.",
  "Negative one times x squared plus four to the negative two, times two x.",
  "So negative two x over x squared plus four, squared.",
  "Notice how the chain rule saved us from using the quotient rule.",
  "Here is a trap: the derivative of sine squared x.",
  "Sine squared x means sine of x, all squared.",
  "So the outer function is u squared, and the inner function is sine x.",
  "Two sine x times cosine x, which some of you know as sine of two x.",
  "It is not cosine squared x, and it is not two sine x alone.",
  "Let's also do the natural log of x squared plus one.",
  "The derivative of log u is one over u, times u prime.",
  "So two x over x squared plus one.",
  "One more: the tangent of five x.",
  "Secant squared of five x, times five.",
  "If you remember one thing today, remember to multiply by the inside derivative.",
  "Okay, that is where we will stop for today.",
  "For practice, try problems twelve through twenty in section three point four.",
  "Office hours are Thursday afternoon if you want to go over any of these.",
];

// mulberry32: tiny deterministic PRNG.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = prng(20260925);
const between = (lo, hi) => lo + (hi - lo) * rand();

const words = [];
let t = 800; // a short breath before the lecturer starts
let sentence = 0;
while (t < durationMs - 1500) {
  const tokens = SENTENCES[sentence % SENTENCES.length].split(/\s+/);
  sentence++;
  for (const w of tokens) {
    if (t >= durationMs - 1500) break;
    const step = Math.round(between(350, 450));
    const len = Math.round(step * between(0.7, 0.9));
    words.push({ w, startMs: t, endMs: t + len });
    t += step;
  }
  // Natural pause between sentences: usually short, every few sentences a 1–3 s breath.
  t += sentence % 3 === 0 ? Math.round(between(1000, 3000)) : Math.round(between(150, 450));
}

writeFileSync(join(demoDir, "lecture.transcript.json"), JSON.stringify(words) + "\n");
const last = words[words.length - 1];
console.log(`wrote public/demo/lecture.transcript.json (${words.length} words, last ends at ${last.endMs} ms)`);
