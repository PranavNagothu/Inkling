// Shared contract for Inkling. All times are lecture-clock milliseconds unless named *Iso.

export type PointerKind = 'pen' | 'mouse' | 'touch';
export type Tool = 'pen' | 'eraser';

/** [x, y, pressure 0..1, lectureMs] in canvas world coordinates. */
export type Point = [number, number, number, number];

export type BBox = [x0: number, y0: number, x1: number, y1: number];

export interface Session {
  id: string;
  studentId: string;
  lectureId: string;
  courseId: string;
  title: string;
  createdAtIso: string;
  inputKind: PointerKind | null;
  hasPressure: boolean;
}

export interface Stroke {
  id: string;
  sessionId: string;
  startMs: number;
  endMs: number;
  points: Point[];
  pointerType: PointerKind;
  bbox: BBox;
  inkLen: number;
  medianSpeed: number; // px per ms
  erased: boolean;
  erasedAtMs: number | null;
  erasedBy: ErasedBy | null;
  /**
   * True for an erasing gesture drawn with the pen (a scribble-out zig-zag, or a strike-through
   * line): stored erased, never counted as ink (see lib/scribble, lib/strike).
   */
  isScribble: boolean;
  /** Set on a piece created by a partial erase: id of the stroke it was cut from. */
  splitFrom?: string | null;
  /**
   * Set when a partial erase cut this stroke into pieces (ids). A replaced stroke is kept for
   * history but is no longer drawn or analysed — its pieces are. See activeStrokes() in ./ink.
   */
  replacedBy?: string[] | null;
}

/**
 * What erased a stroke: the eraser tool, a pen scribble-out, a pen strike-through (a straight line
 * through a word followed by new writing nearby), or Undo.
 */
export type ErasedBy = 'eraser' | 'scribble' | 'strike' | 'undo';

/** An erase gesture: which strokes it removed (or, for 'undo', restored / took back) and when. */
export interface EraseEvent {
  id: string;
  sessionId: string;
  atMs: number;
  strokeIds: string[];
  by: ErasedBy;
}

export interface TranscriptWord {
  w: string;
  startMs: number;
  endMs: number;
}

export type LectureMediaType = 'audio' | 'video';
/** Where a lecture's word timings came from; 'none' = no transcript (pause scoring is disabled). */
export type TranscriptSource = 'demo' | 'captions' | 'whisper' | 'none';

/** Client-safe lecture metadata (the media path on disk never leaves the server). */
export interface Lecture {
  id: string;
  courseId: string;
  title: string;
  mediaType: LectureMediaType;
  mime: string;
  durationMs: number;
  transcriptSource: TranscriptSource;
  wordCount: number;
  createdAtIso: string;
}

/**
 * A Notability PDF export uploaded for a session (client-safe: the stored file name stays on the
 * server). Each session has at most one current import; replaced ones are kept as history.
 */
export interface NotabilityImport {
  id: string;
  sessionId: string;
  /** Sanitised client file name, for display only. */
  fileName: string;
  /** Exact page count when the server could read it cheaply; null otherwise. */
  pageCount: number | null;
  size: number;
  createdAtIso: string;
  current: boolean;
}

export interface TranscriptSegment {
  lectureId: string;
  startMs: number;
  endMs: number;
  text: string;
  words: TranscriptWord[];
}

/**
 * Where a scoring window sits relative to the student's own activity:
 * - idle: before their first stroke, or a stretch they skipped / were away for (no features, never spikes)
 * - baseline: the first `baselineMs` of their writing — calibrates "your normal" (never spikes)
 * - scored: compared against the baseline (may spike)
 */
export type WindowPhase = 'idle' | 'baseline' | 'scored';

export interface ConfusionWindow {
  sessionId: string;
  bucketStartMs: number; // 10 s windows
  pause: number; // 0..1
  slowdown: number; // 0..1
  erase: number; // 0..1
  pressure: number | null; // 0..1, null when pressure is unusable
  rawScore: number;
  emaScore: number;
  isSpike: boolean;
  reasons: string[];
  /** Absent on analyses stored before Phase 6. */
  phase?: WindowPhase;
}

export type RevisionKind = 'correction' | 'deletion' | 'micro' | 'cosmetic';

export interface Revision {
  id: string;
  sessionId: string;
  lectureMs: number;
  beforeStrokeIds: string[];
  afterStrokeIds: string[];
  bbox: BBox;
  kind: RevisionKind;
  vision?: {
    before: string;
    after: string;
    misconception: string;
    conceptLabel: string;
    cosmetic: boolean;
  };
}

export type TimelineEventType = 'misconception_corrected' | 'unresolved_gap' | 'breakthrough';

export interface CheckAttempt {
  atIso: string;
  choiceIdx: number;
  correct: boolean;
}

/** Where a help card came from: a model, the bundled demo fixtures, or the safe offline fallback. */
export type HelpSource = 'ai' | 'demo' | 'fallback';

export interface HelpCard {
  reexplain: string; // <= 80 words
  mcq: { q: string; options: string[]; answerIdx: number; why: string };
  ttsUrl?: string;
  /** Absent on cards stored before Phase 5 shipped. A 'fallback' card is regenerated on next open. */
  source?: HelpSource;
  /** Provider that wrote it ('openai', 'groq', 'gemini', 'grok', 'fake', 'demo'). */
  provider?: string;
}

/**
 * What the client sees of a help card: no answer index or explanation until the student answers
 * (POST /api/events/[id]/check grades on the server).
 */
export interface PublicHelpCard {
  reexplain: string;
  mcq: { q: string; options: string[] };
  source: HelpSource;
  provider: string;
}

/** What a model read from a revision's before/after crops (stored on Revision.vision). */
export type RevisionReading = NonNullable<Revision['vision']>;

/**
 * How a gap got resolved: a correct check answer (Phase 5), writing through the same part of the
 * lecture calmly in a later session ('revisit'), or the student saying "I get it now" ('self').
 */
export type ResolvedBy = 'check' | 'revisit' | 'self';

/** Read-time summary of a gap's story across sessions (computed by lib/progress; never stored). */
export interface GapHistory {
  /** When the first gap on this concept was seen (that session's start). */
  firstSeenIso: string;
  /** 1-based: this gap is the Nth time the concept came up as a gap. */
  occurrence: number;
  /** How many gaps the thread has in total. */
  occurrences: number;
  /** Whole-thread status: open while any of its gaps is open. */
  threadStatus: 'open' | 'resolved';
}

export interface TimelineEvent {
  id: string;
  sessionId: string;
  lectureMs: number;
  type: TimelineEventType;
  status: 'open' | 'resolved';
  /** `${lectureId}@${segmentStartMs}` (lib/concepts); null on analyses stored before Phase 6. */
  conceptId: string | null;
  /** Readable concept name (first words of the sentence, or "Moment at mm:ss"). */
  conceptLabel?: string | null;
  revisionId?: string;
  windowStartMs?: number;
  evidence: { excerpt: string; audioStartMs: number; audioEndMs: number };
  help?: HelpCard;
  checkAttempts: CheckAttempt[];
  resolvedInSessionId?: string;
  resolvedBy?: ResolvedBy;
  resolvedAtIso?: string;
  /** Set when the student said "Still confused": later sessions only count if they start after it. */
  reopenedAtIso?: string;
  /** Id of the earlier gap on the same concept that this gap repeats ("2nd time"). */
  repeatOf?: string;
  /** Attached when served (not stored). */
  history?: GapHistory;
}

export interface Concept {
  id: string;
  courseId: string;
  label: string;
  aliases: string[];
}

/** A stretch of lecture time, [startMs, endMs). */
export interface TimeRange {
  startMs: number;
  endMs: number;
}

/** Everything the review timeline needs for one session (computed by lib/analyze.ts, stored in the DB). */
export interface TimelineData {
  /** Length of the lecture-time track in ms. */
  durationMs: number;
  windows: ConfusionWindow[];
  revisions: Revision[];
  events: TimelineEvent[];
  /**
   * Where the student's baseline ("your normal") was measured, as contiguous stretches of lecture
   * time (derived from the windows' phases; see baselineZones in ./scoring). Hatched on the timeline.
   */
  baseline: TimeRange[];
}
