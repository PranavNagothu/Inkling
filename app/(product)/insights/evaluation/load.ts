import "server-only";

// Loads the labeled demo set for /insights/evaluation and GET /api/evaluation: the seeded sessions'
// stored ink when the demo is seeded (`npm run seed:demo`), else the same ink rebuilt by
// lib/demoScenario — then scores it with the app's own pipeline (lib/evaluation).
import groundTruthJson from "@/public/demo/ground-truth.json";
import { analysisDurationMs } from "@/lib/analyze";
import { getDb } from "@/lib/db";
import { demoEvaluationCases, evaluateCases, parseGroundTruth, type EvalCase, type EvaluationReport, type GroundTruth } from "@/lib/evaluation";
import { getSessionLecture } from "@/lib/lecture";

async function storedCase(fallback: EvalCase): Promise<EvalCase> {
  try {
    const db = getDb();
    const session = await db.getSession(fallback.sessionId);
    if (!session) return fallback;
    const [strokes, eraseEvents] = await Promise.all([db.getStrokes(session.id), db.getEraseEvents(session.id)]);
    if (strokes.length === 0) return fallback;
    const { lecture, words } = await getSessionLecture(session.lectureId);
    return {
      ...fallback,
      lectureId: lecture.id,
      strokes,
      eraseEvents,
      words,
      durationMs: analysisDurationMs(lecture.durationMs, strokes, eraseEvents),
      hasTranscript: lecture.transcriptSource !== "none" && words.length > 0,
      source: "stored",
    };
  } catch (err) {
    console.error(`[inkling] evaluation: using the scenario for ${fallback.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  }
}

export async function loadEvaluation(): Promise<{ groundTruth: GroundTruth; report: EvaluationReport }> {
  const groundTruth = parseGroundTruth(groundTruthJson);
  const cases = await Promise.all(demoEvaluationCases(groundTruth).map(storedCase));
  return { groundTruth, report: evaluateCases(cases, { toleranceMs: groundTruth.toleranceMs }) };
}
