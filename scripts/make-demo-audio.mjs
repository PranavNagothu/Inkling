// Generates a placeholder demo lecture: public/demo/lecture.wav (6 min, 8 kHz mono, 8-bit PCM,
// a quiet low hum) and public/demo/lecture.json. Replaced by a real lecture in Phase 4.
// Six minutes so a session outlasts the 120 s scoring baseline (lib/scoring.ts) with room to spare.
// Usage: node scripts/make-demo-audio.mjs   (then: node scripts/make-demo-transcript.mjs)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "demo");
mkdirSync(outDir, { recursive: true });

const DURATION_S = 360;
const SAMPLE_RATE = 8000;
const n = SAMPLE_RATE * DURATION_S;
const dataBytes = n; // 8-bit mono: one byte per sample
const buf = Buffer.alloc(44 + dataBytes);

// RIFF / WAVE header
buf.write("RIFF", 0);
buf.writeUInt32LE(36 + dataBytes, 4);
buf.write("WAVE", 8);
buf.write("fmt ", 12);
buf.writeUInt32LE(16, 16); // PCM chunk size
buf.writeUInt16LE(1, 20); // PCM
buf.writeUInt16LE(1, 22); // mono
buf.writeUInt32LE(SAMPLE_RATE, 24);
buf.writeUInt32LE(SAMPLE_RATE, 28); // byte rate
buf.writeUInt16LE(1, 32); // block align
buf.writeUInt16LE(8, 34); // bits per sample (unsigned, 128 = silence)
buf.write("data", 36);
buf.writeUInt32LE(dataBytes, 40);

// Quiet 110 Hz hum with a slow 0.25 Hz swell so it is audibly "playing" but unobtrusive.
const amp = 0.03 * 127;
for (let i = 0; i < n; i++) {
  const t = i / SAMPLE_RATE;
  const swell = 0.6 + 0.4 * Math.sin(2 * Math.PI * 0.25 * t);
  const fade = Math.min(1, t / 1.5, (DURATION_S - t) / 1.5);
  const v = amp * swell * fade * Math.sin(2 * Math.PI * 110 * t);
  buf.writeUInt8(128 + Math.round(v), 44 + i);
}

writeFileSync(join(outDir, "lecture.wav"), buf);
const meta = {
  lectureId: "demo-chain-rule",
  courseId: "calc1",
  title: "Calculus I — The Chain Rule (demo)",
  durationMs: DURATION_S * 1000,
  audioUrl: "/demo/lecture.wav",
};
writeFileSync(join(outDir, "lecture.json"), JSON.stringify(meta, null, 2) + "\n");
console.log(`wrote public/demo/lecture.wav (${(buf.length / 1e6).toFixed(2)} MB) and lecture.json`);
