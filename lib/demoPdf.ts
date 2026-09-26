import "server-only";

// The seeded demo's "Notability export": a one-page PDF of what a final-page-only notes app keeps —
// the session's live ink on ruled paper, and none of the erased attempts. The page is the same
// frame the compare screen fits the process into (inkFrame in ./compare), so the overlay lines up
// exactly. Vector paths only (no fonts), so pdf.js renders it offline with nothing to fetch.
// pdf-lib is a devDependency: this runs from scripts/seed-demo (a dev install), never in the app.
import { LineCapStyle, PDFDocument, rgb } from "pdf-lib";
import { inkFrame } from "./compare";
import { activeStrokes } from "./ink";
import type { Stroke } from "./types";

const PAPER = rgb(1, 0.988, 0.961); // --color-paper
const RULE = rgb(0.922, 0.898, 0.843); // --color-rule
const INK = rgb(0.11, 0.102, 0.09); // --color-ink
const RULE_GAP = 32;
const FIRST_RULE = 47;

const f1 = (v: number) => (Math.round(v * 10) / 10).toString();

export async function renderFinalPagePdf(strokes: Stroke[], meta: { title: string; createdAt?: Date }): Promise<Uint8Array> {
  const [x0, y0, x1, y1] = inkFrame(strokes);
  const width = x1 - x0;
  const height = y1 - y0;
  const doc = await PDFDocument.create();
  doc.setTitle(meta.title);
  doc.setCreator("Inkling demo seed (scripts/seed-demo)");
  doc.setProducer("Inkling demo seed");
  if (meta.createdAt) {
    doc.setCreationDate(meta.createdAt);
    doc.setModificationDate(meta.createdAt);
  }
  const page = doc.addPage([width, height]);
  page.drawRectangle({ x: 0, y: 0, width, height, color: PAPER });
  for (let y = FIRST_RULE; y < height; y += RULE_GAP) {
    page.drawLine({ start: { x: 0, y: height - y }, end: { x: width, y: height - y }, thickness: 1, color: RULE });
  }
  // The final page: live ink only (what survived the eraser).
  for (const s of activeStrokes(strokes)) {
    if (s.erased || s.points.length === 0) continue;
    const pts = s.points.map(([x, y]) => [x - x0, y - y0]);
    const d =
      pts.length === 1
        ? `M${f1(pts[0][0])} ${f1(pts[0][1])} L${f1(pts[0][0] + 0.2)} ${f1(pts[0][1] + 0.2)}`
        : pts.map(([x, y], i) => `${i ? "L" : "M"}${f1(x)} ${f1(y)}`).join(" ");
    const pressure = s.points.reduce((a, p) => a + p[2], 0) / s.points.length;
    // SVG coordinates (y down) from the page's top-left corner.
    page.drawSvgPath(d, {
      x: 0,
      y: height,
      borderColor: INK,
      borderWidth: s.pointerType === "pen" ? 2.4 * (0.5 + pressure) : 2.4,
      borderLineCap: LineCapStyle.Round,
    });
  }
  return doc.save({ useObjectStreams: false });
}
