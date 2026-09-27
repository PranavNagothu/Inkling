import "server-only";

// Seeds the polished demo (scripts/seed-demo → `npm run seed:demo`) on whatever database the app
// uses (SQLite by default, Postgres / Tiger Data with DATABASE_URL). It stores the scenario from
// ./demoScenario and then runs the app's own pipeline over it — analysis, gap reconciliation, the
// check-question grading — so what the demo shows is exactly what the app computes.
//
// Idempotent: when the demo is already complete it changes nothing; `reset` rebuilds it (only the
// demo's own sessions are touched). Every seeded moment has DEMO_MODE fixtures
// (public/demo/ai-cache.json), so help cards and revision readings work offline.
import { unlink, writeFile } from "node:fs/promises";
import demoFixturesJson from "@/public/demo/ai-cache.json";
import { analyzeSession } from "./analyze";
import { demoEntryFor, demoHelpCard, parseDemoFixtures } from "./ai/demo";
import { LOCAL_STUDENT_ID, getDb, type Db } from "./db";
import { DEMO_LECTURE } from "./demo";
import { renderFinalPagePdf } from "./demoPdf";
import {
  DEMO_CLASSMATES,
  DEMO_SESSIONS,
  DEMO_TIMES,
  buildClassmate,
  buildMayaSession1,
  buildMayaSession2,
  classmateSessionId,
  classmateStudentId,
  type ScenarioPage,
} from "./demoScenario";
import { answerCheckQuestion } from "./gaps";
import { countPdfPages, storedPdfName } from "./notability";
import { pdfUploadTarget, resolvePdfPath } from "./storage";
import type { TimelineEvent } from "./types";

export const DEMO_PDF_NAME = "Chain rule — Maya (Notability export).pdf";

export interface SeedSummary {
  status: "seeded" | "already-seeded";
  sessions: Array<{ id: string; title: string; moments: Array<Pick<TimelineEvent, "type" | "status" | "lectureMs">> }>;
}

const HOUR = 3_600_000;

/** Every session the demo owns (Maya's two and the classmates'); anything else is a visitor's. */
export const allDemoSessionIds = () => [
  DEMO_SESSIONS.s1.id,
  DEMO_SESSIONS.s2.id,
  ...Array.from({ length: DEMO_CLASSMATES }, (_, i) => classmateSessionId(i)),
];

/** True when every part of the demo is stored (a crash mid-seed leaves it incomplete → rebuilt). */
async function isComplete(db: Db): Promise<boolean> {
  for (const id of allDemoSessionIds()) if (!(await db.getSession(id))) return false;
  const s1 = await db.getAnalysis(DEMO_SESSIONS.s1.id);
  const s2 = await db.getAnalysis(DEMO_SESSIONS.s2.id);
  if (!s1 || s1.stale || !s2 || s2.stale) return false;
  const pdf = await db.getNotabilityImport(DEMO_SESSIONS.s1.id);
  return !!pdf && !!resolvePdfPath(pdf.storedName);
}

/** Deletes the demo's sessions; returns the Notability PDFs they owned (absolute paths). */
async function removeDemo(db: Db): Promise<string[]> {
  const files: string[] = [];
  for (const id of allDemoSessionIds()) {
    const { notabilityFiles } = await db.deleteSession(id);
    for (const name of notabilityFiles) {
      const abs = resolvePdfPath(name);
      if (abs) files.push(abs);
    }
  }
  return files;
}

/** Best-effort removal of files whose rows are gone. */
export async function unlinkAll(files: string[]): Promise<void> {
  await Promise.all(files.map((f) => unlink(f).catch(() => {})));
}

async function store(db: Db, session: { id: string; title: string; studentId: string; createdAtIso: string }, page: ScenarioPage) {
  await db.createSession({
    id: session.id,
    title: session.title,
    studentId: session.studentId,
    createdAtIso: session.createdAtIso,
    lectureId: DEMO_LECTURE.lectureId,
    courseId: DEMO_LECTURE.courseId,
  });
  await db.upsertStrokes(session.id, page.strokes);
  await db.addEraseEvents(session.id, page.eraseEvents);
}

/**
 * `removedFiles`: when given, the replaced Notability PDFs are handed to it instead of being deleted
 * at the end, so a caller running the seed inside a transaction can delete them after COMMIT (a
 * rollback then still finds them). Without it they are deleted once the new demo is stored.
 */
export async function seedDemo(
  opts: { reset?: boolean; now?: Date; removedFiles?: (files: string[]) => void } = {},
): Promise<SeedSummary> {
  const db = getDb();
  if (!(await db.getLecture(DEMO_LECTURE.lectureId))) throw new Error("the bundled demo lecture is missing");
  if (!opts.reset && (await isComplete(db))) return { status: "already-seeded", sessions: await summary(db) };
  const obsolete = await removeDemo(db);

  const now = (opts.now ?? new Date()).getTime();
  const fixtures = parseDemoFixtures(demoFixturesJson);
  const s1At = new Date(now - 26 * HOUR).toISOString();

  // Classmates first (oldest): only the class-wide hotspots use them.
  for (let i = 0; i < DEMO_CLASSMATES; i++) {
    await store(
      db,
      { id: classmateSessionId(i), title: `Classmate ${i + 1}`, studentId: classmateStudentId(i), createdAtIso: new Date(now - (30 + i) * HOUR).toISOString() },
      buildClassmate(i),
    );
  }

  // Session 1: the notes with two corrections and a gap.
  await store(db, { ...DEMO_SESSIONS.s1, studentId: LOCAL_STUDENT_ID, createdAtIso: s1At }, buildMayaSession1());
  const analysis = await analyzeSession(DEMO_SESSIONS.s1.id);
  if (!analysis) throw new Error("session 1 analysis failed");

  // Readable concept names (the fixtures' labels) for every moment, as DEMO_MODE would set them.
  for (const e of analysis.events) {
    const entry = demoEntryFor(fixtures, DEMO_LECTURE.lectureId, e.lectureMs);
    if (entry && e.conceptId) await db.setConceptLabel(DEMO_LECTURE.lectureId, e.conceptId, entry.label);
  }

  // The 01:02 correction was already worked through: read, explained, answered → a breakthrough.
  const answered = analysis.events.find((e) => e.type === "misconception_corrected" && e.lectureMs === DEMO_TIMES.breakthroughEraseMs);
  const entry = answered ? demoEntryFor(fixtures, DEMO_LECTURE.lectureId, answered.lectureMs) : null;
  if (!answered || !entry?.revision || !answered.revisionId) throw new Error("demo scenario: the 01:02 correction is missing");
  await db.setRevisionVision(answered.revisionId, entry.revision);
  await db.setEventHelp(answered.id, demoHelpCard(entry));
  const graded = await answerCheckQuestion(answered.id, entry.help.mcq.answerIdx, new Date(Date.parse(s1At) + 40 * 60_000).toISOString());
  if (!graded.ok || !graded.correct) throw new Error("demo scenario: could not answer the 01:02 check question");

  // The Notability export of session 1: the final page only.
  const pdf = await renderFinalPagePdf(await db.getStrokes(DEMO_SESSIONS.s1.id), { title: "Chain rule — Maya", createdAt: new Date(s1At) });
  const storedName = storedPdfName();
  await writeFile(pdfUploadTarget(storedName), pdf, { flag: "wx", mode: 0o600 });
  await db.addNotabilityImport({
    sessionId: DEMO_SESSIONS.s1.id,
    fileName: DEMO_PDF_NAME,
    storedName,
    pageCount: countPdfPages(Buffer.from(pdf).toString("latin1")),
    size: pdf.byteLength,
  });

  // Session 2 (today): writes the product/chain example through calmly → resolves the gap by revisit.
  await store(db, { ...DEMO_SESSIONS.s2, studentId: LOCAL_STUDENT_ID, createdAtIso: new Date(now - HOUR).toISOString() }, buildMayaSession2());
  await analyzeSession(DEMO_SESSIONS.s2.id);

  // Timescale: materialise the class-wide hotspots now rather than at the next policy run.
  await (db as Db & { refreshInkAggregates?: () => Promise<void> }).refreshInkAggregates?.();
  if (opts.removedFiles) opts.removedFiles(obsolete);
  else await unlinkAll(obsolete);
  return { status: "seeded", sessions: await summary(db) };
}

async function summary(db: Db): Promise<SeedSummary["sessions"]> {
  const out: SeedSummary["sessions"] = [];
  for (const { id, title } of [DEMO_SESSIONS.s1, DEMO_SESSIONS.s2]) {
    const events = (await db.getAnalysis(id))?.events ?? [];
    out.push({ id, title, moments: events.map(({ type, status, lectureMs }) => ({ type, status, lectureMs })) });
  }
  return out;
}
