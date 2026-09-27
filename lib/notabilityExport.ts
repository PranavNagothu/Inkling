import "server-only";

// "Send back to Notability": a session exported as a PDF a student can import into Notability (or
// any notes app) to keep the process next to the final notes (GET /api/sessions/[id]/export).
//   Page 1 — the notes: live ink on ruled paper, erased ink as dashed teal ghost ink, and each
//            moment outlined and labelled (Corrected / Gap / Breakthrough). Same frame as the compare
//            screen (inkFrame), plus a legend strip at the bottom.
//   Page 2 — the moments, in lecture order: time, type, what the AI read before → after, what the
//            lecturer was saying, and the re-explanation (continued on more pages when needed).
// Built with pdf-lib and its standard Helvetica (no font files, nothing fetched). Standard fonts only
// encode WinAnsi, so every string goes through toWinAnsi first — pdf-lib never sees a character it
// would throw on.
import { LineCapStyle, PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { inkFrame, momentAnchors } from "./compare";
import { activeStrokes } from "./ink";
import { formatClock } from "./time";
import type { BBox, Revision, Stroke, TimelineEvent, TimelineEventType } from "./types";

export const MOMENT_PDF_LABEL: Record<TimelineEventType, string> = {
  misconception_corrected: "Corrected",
  unresolved_gap: "Gap",
  breakthrough: "Breakthrough",
};

/** Long lecture excerpts are cut to this many words on page 2. */
const EXCERPT_WORDS = 45;
/**
 * Any one text line on page 2 is cut to this many characters. Stored text is untrusted (uploaded
 * captions can hold one enormous "word"), and without a cap it could run to hundreds of pages.
 */
export const MAX_LINE_CHARS = 1200;
/**
 * Largest page side (pt): PDF viewers refuse pages over 14 400 units. A real notes canvas is a
 * screen or two in size; stored stroke boxes are client data, so the notes page is capped here
 * (ink beyond it is off the page) rather than sized — and ruled — to whatever a stroke claims.
 */
export const MAX_PAGE_PT = 14_400;

const capChars = (t: string, max: number = MAX_LINE_CHARS) => (t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t);

/** Height of the legend strip under the notes on page 1 (pt). */
export const EXPORT_FOOTER_PT = 30;

const hex = (h: string): RGB => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);

// Mirrors the --color-* tokens in app/(product)/globals.css.
const C = {
  paper: hex("#fffffd"),
  rule: hex("#dbe5ee"),
  line: hex("#e2e8f0"),
  chrome: hex("#ffffff"),
  ink: hex("#0f172a"),
  muted: hex("#475569"),
  subtle: hex("#526176"),
  ghost: hex("#0d9488"),
  white: rgb(1, 1, 1),
};
/** Outline colour and text-safe tag colour per moment type. */
const MOMENT_COLOR: Record<TimelineEventType, { line: RGB; strong: RGB }> = {
  misconception_corrected: { line: hex("#0284c7"), strong: hex("#075985") },
  unresolved_gap: { line: hex("#d97706"), strong: hex("#92400e") },
  breakthrough: { line: hex("#1e293b"), strong: hex("#0f172a") },
};

// ---------------------------------------------------------------------------------------------
// Text

/** Stand-ins for common math/typography characters outside WinAnsi (² · — “ ” … are inside it). */
const SUBSTITUTES: Record<string, string> = {
  "→": "->", "←": "<-", "↔": "<->", "⇒": "=>", "⇐": "<=", "⇔": "<=>", "⟶": "->", "↦": "|->",
  "−": "-", "‐": "-", "‑": "-", "⁄": "/", "∕": "/", "⋅": "·", "∙": "·", "∗": "*",
  "≤": "<=", "≥": ">=", "≠": "!=", "≈": "~", "≡": "==", "∼": "~", "∝": "~",
  "√": "sqrt", "∛": "cbrt", "∞": "inf", "∫": "integral", "∑": "sum", "Σ": "Sum", "∏": "prod", "∂": "d", "∇": "grad",
  "∈": " in ", "∉": " not in ", "∀": "for all ", "∃": "exists ", "∴": "therefore", "′": "'", "″": "''",
  "π": "pi", "θ": "theta", "α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta", "Δ": "Delta", "ε": "epsilon",
  "λ": "lambda", "μ": "mu", "σ": "sigma", "φ": "phi", "ω": "omega", "Ω": "Omega", "τ": "tau", "ρ": "rho",
  "⁰": "^0", "⁴": "^4", "⁵": "^5", "⁶": "^6", "⁷": "^7", "⁸": "^8", "⁹": "^9", "⁺": "^+", "⁻": "^-", "ⁿ": "^n",
  "₀": "_0", "₁": "_1", "₂": "_2", "₃": "_3", "₄": "_4", "₅": "_5", "₆": "_6", "₇": "_7", "₈": "_8", "₉": "_9",
  "✓": "v", "✔": "v", "✗": "x",
};

/** Windows-1252 (WinAnsi) as Unicode code points: what the standard fonts can encode. */
const WIN_ANSI: ReadonlySet<number> = new Set([
  ...Array.from({ length: 0x7f - 0x20 }, (_, i) => 0x20 + i),
  ...Array.from({ length: 0x100 - 0xa0 }, (_, i) => 0xa0 + i),
  ...[..."€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ"].map((c) => c.codePointAt(0)!),
]);

/**
 * `text` with every character the font can't encode replaced: known math symbols by ASCII stand-ins,
 * accented / styled letters by their base letter, anything else by "?". Whitespace runs (including
 * newlines and tabs) become one space.
 */
export function toWinAnsi(text: string, supported: ReadonlySet<number> = WIN_ANSI): string {
  const ok = (s: string) => [...s].every((ch) => supported.has(ch.codePointAt(0)!));
  let out = "";
  for (const ch of text.replace(/\s+/g, " ")) {
    if (supported.has(ch.codePointAt(0)!)) out += ch;
    else if (SUBSTITUTES[ch] !== undefined && ok(SUBSTITUTES[ch])) out += SUBSTITUTES[ch];
    else {
      const base = ch.normalize("NFKD").replace(/\p{M}/gu, "");
      out += base && ok(base) ? base : "?";
    }
  }
  return out;
}

/** Greedy word wrap to `maxWidth`; a word longer than a line is broken across lines. */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (measure(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = "";
    let rest = word;
    while (measure(rest) > maxWidth) {
      let cut = 1;
      while (cut < rest.length && measure(rest.slice(0, cut + 1)) <= maxWidth) cut++;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    current = rest;
  }
  if (current) lines.push(current);
  return lines;
}

/** "inkling-<safe-title>.pdf": lowercase ASCII letters, digits and single dashes (max 60). */
export function exportFileName(title: string): string {
  const safe = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");
  return `inkling-${safe || "notes"}.pdf`;
}

export interface MomentBlock {
  type: TimelineEventType;
  lectureMs: number;
  /** "01:40 · Corrected" */
  heading: string;
  lines: Array<{ label: string; text: string }>;
}

/** What page 2 says about each moment (pure; unencoded text). */
export function momentBlocks(events: TimelineEvent[], revisions: Revision[]): MomentBlock[] {
  const byId = new Map(revisions.map((r) => [r.id, r]));
  return [...events]
    .sort((a, b) => a.lectureMs - b.lectureMs)
    .map((e) => {
      const vision = e.revisionId ? byId.get(e.revisionId)?.vision : undefined;
      const lines: MomentBlock["lines"] = [];
      const concept = e.conceptLabel ?? vision?.conceptLabel;
      if (concept) lines.push({ label: "Concept", text: concept });
      if (vision && (vision.before || vision.after)) lines.push({ label: "Reading", text: `${vision.before || "…"} → ${vision.after || "…"}` });
      if (vision?.misconception) lines.push({ label: "What changed", text: vision.misconception });
      const excerpt = e.evidence.excerpt.trim().split(/\s+/).filter(Boolean);
      if (excerpt.length) {
        const cut = excerpt.length > EXCERPT_WORDS ? `${excerpt.slice(0, EXCERPT_WORDS).join(" ")}…` : excerpt.join(" ");
        lines.push({ label: "Lecture", text: `“${cut}”` });
      }
      if (e.help?.reexplain) lines.push({ label: "Re-explanation", text: e.help.reexplain });
      if (e.type === "unresolved_gap") lines.push({ label: "Status", text: e.status === "resolved" ? "Resolved" : "Still open" });
      return {
        type: e.type,
        lectureMs: e.lectureMs,
        heading: `${formatClock(e.lectureMs)} · ${MOMENT_PDF_LABEL[e.type]}`,
        lines: lines.map((l) => ({ label: l.label, text: capChars(l.text) })),
      };
    });
}

// ---------------------------------------------------------------------------------------------
// Drawing

const f1 = (v: number) => (Math.round(v * 10) / 10).toString();

/** SVG path data for a stroke, relative to the frame's top-left corner. */
function strokePath(s: Stroke, x0: number, y0: number): string {
  const pts = s.points.map(([x, y]) => [x - x0, y - y0]);
  if (pts.length === 1) return `M${f1(pts[0][0])} ${f1(pts[0][1])} L${f1(pts[0][0] + 0.2)} ${f1(pts[0][1] + 0.2)}`;
  return pts.map(([x, y], i) => `${i ? "L" : "M"}${f1(x)} ${f1(y)}`).join(" ");
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  supported: ReadonlySet<number>;
}

function notesPage(doc: PDFDocument, fonts: Fonts, input: NotabilityExportInput) {
  const [x0, y0, x1, y1] = inkFrame(input.strokes);
  const width = Math.min(MAX_PAGE_PT, x1 - x0);
  const paperH = Math.min(MAX_PAGE_PT - EXPORT_FOOTER_PT, y1 - y0);
  const height = paperH + EXPORT_FOOTER_PT;
  const page = doc.addPage([width, height]);
  // World (y down) → page (y up).
  const py = (y: number) => height - (y - y0);

  page.drawRectangle({ x: 0, y: 0, width, height, color: C.chrome });
  page.drawRectangle({ x: 0, y: EXPORT_FOOTER_PT, width, height: paperH, color: C.paper });
  for (let y = 47; y < paperH; y += 32) {
    page.drawLine({ start: { x: 0, y: height - y }, end: { x: width, y: height - y }, thickness: 1, color: C.rule });
  }

  const shown = activeStrokes(input.strokes).filter((s) => s.points.length > 0);
  // Ghost ink first (scribble zig-zags fainter), live ink on top — as on the review canvas.
  for (const s of shown) {
    if (!s.erased) continue;
    page.drawSvgPath(strokePath(s, x0, y0), {
      x: 0,
      y: height,
      borderColor: C.ghost,
      borderWidth: 2.2,
      borderOpacity: s.isScribble ? 0.3 : 0.75,
      borderDashArray: [6, 5],
      borderLineCap: LineCapStyle.Round,
    });
  }
  for (const s of shown) {
    if (s.erased) continue;
    const pressure = s.points.reduce((a, p) => a + p[2], 0) / s.points.length;
    page.drawSvgPath(strokePath(s, x0, y0), {
      x: 0,
      y: height,
      borderColor: C.ink,
      borderWidth: s.pointerType === "pen" ? 2.4 * (0.5 + (pressure > 0 ? pressure : 0.5)) : 2.4,
      borderLineCap: LineCapStyle.Round,
    });
  }

  // Moments: a dashed outline around where each happened on the page, with a small label tag.
  for (const { event, bbox } of momentAnchors(input.events, input.revisions, input.strokes)) {
    drawMoment(page, fonts, event, bbox, { width, py, paperTop: height, paperBottom: EXPORT_FOOTER_PT });
  }

  drawLegend(page, fonts, input.title, width);
}

function drawMoment(
  page: PDFPage,
  fonts: Fonts,
  event: TimelineEvent,
  bbox: BBox,
  geo: { width: number; py: (y: number) => number; paperTop: number; paperBottom: number },
) {
  const pad = 8;
  const color = MOMENT_COLOR[event.type];
  const left = Math.max(1, bbox[0] - pad);
  const right = Math.min(geo.width - 1, bbox[2] + pad);
  const top = Math.min(geo.paperTop - 1, geo.py(bbox[1] - pad));
  const bottom = Math.max(geo.paperBottom + 1, geo.py(bbox[3] + pad));
  page.drawRectangle({
    x: left,
    y: bottom,
    width: Math.max(4, right - left),
    height: Math.max(4, top - bottom),
    color: color.line,
    opacity: 0.07,
    borderColor: color.line,
    borderWidth: 1.5,
    borderDashArray: [5, 4],
  });

  const text = toWinAnsi(`${MOMENT_PDF_LABEL[event.type]} ${formatClock(event.lectureMs)}`, fonts.supported);
  const size = 7.5;
  const tagW = fonts.bold.widthOfTextAtSize(text, size) + 8;
  const tagH = 11;
  // Straddles the outline's top edge (half above), so it covers as little of the notes as possible.
  const tagY = Math.min(geo.paperTop - tagH - 1, top - tagH / 2);
  const tagX = Math.min(Math.max(1, left + 6), geo.width - tagW - 1);
  page.drawRectangle({ x: tagX, y: tagY, width: tagW, height: tagH, color: color.strong });
  page.drawText(text, { x: tagX + 4, y: tagY + 3.2, size, font: fonts.bold, color: C.white });
}

function drawLegend(page: PDFPage, fonts: Fonts, title: string, width: number) {
  const y = 11;
  const size = 8.5;
  page.drawLine({ start: { x: 0, y: EXPORT_FOOTER_PT }, end: { x: width, y: EXPORT_FOOTER_PT }, thickness: 0.75, color: C.line });
  let x = 12;
  page.drawLine({ start: { x, y: y + 3 }, end: { x: x + 18, y: y + 3 }, thickness: 2, color: C.ghost, dashArray: [4, 3] });
  x += 23;
  const ghostLabel = "erased, kept";
  page.drawText(ghostLabel, { x, y, size, font: fonts.regular, color: C.muted });
  x += fonts.regular.widthOfTextAtSize(ghostLabel, size) + 12;
  for (const type of ["misconception_corrected", "unresolved_gap", "breakthrough"] as const) {
    page.drawRectangle({ x, y: y - 1, width: 10, height: 10, borderColor: MOMENT_COLOR[type].line, borderWidth: 1.5, borderDashArray: [3, 2] });
    x += 14;
    page.drawText(MOMENT_PDF_LABEL[type], { x, y, size, font: fonts.regular, color: C.muted });
    x += fonts.regular.widthOfTextAtSize(MOMENT_PDF_LABEL[type], size) + 12;
  }
  // The title, right-aligned, when there's room for it.
  const label = toWinAnsi(`${title} · Inkling`, fonts.supported);
  const w = fonts.regular.widthOfTextAtSize(label, size);
  if (x + w + 12 <= width) page.drawText(label, { x: width - w - 12, y, size, font: fonts.regular, color: C.subtle });
}

const LETTER: [number, number] = [612, 792];
const MARGIN = 48;

function momentsPages(doc: PDFDocument, fonts: Fonts, input: NotabilityExportInput) {
  const [pw, ph] = LETTER;
  const maxW = pw - MARGIN * 2;
  const enc = (s: string) => toWinAnsi(s, fonts.supported);
  let page = doc.addPage(LETTER);
  let y = ph - MARGIN;

  const ensure = (needed: number) => {
    if (y - needed >= MARGIN) return;
    page = doc.addPage(LETTER);
    y = ph - MARGIN;
    // One line: the first wrapped line of the header, so a long title never runs off the page.
    const [header = ""] = wrapText(enc(`Moments (continued) · ${input.title}`), maxW, (s) => fonts.bold.widthOfTextAtSize(s, 10));
    page.drawText(header, { x: MARGIN, y: y - 10, size: 10, font: fonts.bold, color: C.muted });
    y -= 28;
  };
  const para = (text: string, font: PDFFont, size: number, color: RGB, indent = 0, lead = size * 1.3) => {
    for (const l of wrapText(enc(text), maxW - indent, (s) => font.widthOfTextAtSize(s, size))) {
      ensure(lead);
      page.drawText(l, { x: MARGIN + indent, y: y - size, size, font, color });
      y -= lead;
    }
  };

  para(capChars(`Moments · ${input.title}`, 240), fonts.bold, 18, C.ink);
  y -= 2;
  const created = (input.now ?? new Date()).toISOString().slice(0, 10);
  para(
    [input.lectureTitle ? `Lecture: ${capChars(input.lectureTitle, 240)}` : null, `Exported from Inkling on ${created}`].filter(Boolean).join(" · "),
    fonts.regular,
    10,
    C.muted,
  );
  para("What your final page doesn't show: every correction, gap and breakthrough, and when it happened in the lecture.", fonts.regular, 10, C.muted);
  y -= 10;

  const blocks = momentBlocks(input.events, input.revisions);
  if (blocks.length === 0) {
    para("No moments in this session yet — your notes were written through without corrections or hesitations.", fonts.regular, 11, C.ink);
    return;
  }
  for (const block of blocks) {
    ensure(18 + 14 * Math.min(2, block.lines.length));
    const color = MOMENT_COLOR[block.type];
    page.drawRectangle({ x: MARGIN, y: y - 11, width: 9, height: 9, color: color.line });
    para(block.heading, fonts.bold, 12, color.strong, 16);
    y -= 2;
    for (const { label, text } of block.lines) {
      para(label, fonts.bold, 8, C.subtle, 16, 10);
      para(text, fonts.regular, 10, C.ink, 16);
      y -= 2;
    }
    y -= 8;
    ensure(2);
    page.drawLine({ start: { x: MARGIN, y: y + 5 }, end: { x: pw - MARGIN, y: y + 5 }, thickness: 0.5, color: C.line });
  }
}

export interface NotabilityExportInput {
  title: string;
  lectureTitle?: string | null;
  strokes: Stroke[];
  events: TimelineEvent[];
  revisions: Revision[];
  /** Export date (defaults to now). */
  now?: Date;
}

export async function buildNotabilityExport(input: NotabilityExportInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const now = input.now ?? new Date();
  // Document metadata is UTF-16: any title is fine here.
  doc.setTitle(input.title);
  doc.setSubject("Inkling notes with ghost ink and learning moments");
  doc.setCreator("Inkling");
  doc.setProducer("Inkling");
  doc.setCreationDate(now);
  doc.setModificationDate(now);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const boldSet = new Set(bold.getCharacterSet());
  const supported = new Set(regular.getCharacterSet().filter((cp) => boldSet.has(cp)));
  const fonts: Fonts = { regular, bold, supported };
  notesPage(doc, fonts, input);
  momentsPages(doc, fonts, { ...input, now });
  return doc.save();
}
