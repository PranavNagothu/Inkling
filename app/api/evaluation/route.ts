import { loadEvaluation } from "@/app/(product)/insights/evaluation/load";

/** Precision / recall of Inkling's detectors on the small labeled demo set (see lib/evaluation). */
export async function GET() {
  const { groundTruth, report } = await loadEvaluation();
  return Response.json({
    groundTruth: { name: groundTruth.name, note: groundTruth.note, toleranceMs: groundTruth.toleranceMs },
    report,
  });
}
