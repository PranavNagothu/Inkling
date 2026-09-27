// Contract for the AI layer (Phase 5). Providers turn untrusted lecture text (and ink crops) into
// validated, size-limited results; everything else (caching, limits, persistence) lives in
// ./service. Types only.
import type { HelpCard, RevisionReading, TimelineEventType } from '../types';
import type { LanguageCode } from './languages';

export type ProviderName = 'openai' | 'groq' | 'gemini' | 'grok' | 'fake';

/** How AI requests are served (see ./select). */
export type AiMode = 'live' | 'fake' | 'demo' | 'off';

/** Client-safe summary of the AI selection (never includes keys). */
export interface AiStatus {
  enabled: boolean;
  mode: AiMode;
  provider: ProviderName | null;
  model: string | null;
  /**
   * Whether the server can read explanations aloud (a TTS voice is configured, see ./tts). Lets
   * Read aloud decide on the first tap: without a server voice it speaks in the browser right
   * away, inside the tap (iPad Safari only speaks from a user gesture). Undefined = unknown.
   */
  tts?: boolean;
}

/** What a help card is written from. All strings except `momentType` are untrusted data. */
export interface HelpContext {
  lectureTitle: string;
  conceptLabel: string | null;
  /** Transcript excerpt around the moment. */
  excerpt: string;
  momentType: TimelineEventType;
  /** Lecture time of the moment, "mm:ss". */
  clock: string;
  /** What a revision reading said the student got wrong, when there is one. */
  misconception: string | null;
}

export interface RevisionInput {
  /** PNG data URLs (validated by ./dataUrl before they get here). */
  beforePng: string;
  afterPng: string;
  excerpt: string;
}

export interface CallOptions {
  signal?: AbortSignal;
}

/** A card as a provider returns it (source/provider are stamped by the service). */
export type HelpCardCore = Pick<HelpCard, 'reexplain' | 'mcq'>;

export interface AiProvider {
  readonly name: ProviderName;
  readonly model: string;
  helpFor(ctx: HelpContext, opts?: CallOptions): Promise<HelpCardCore>;
  readRevision(input: RevisionInput, opts?: CallOptions): Promise<RevisionReading>;
  labelConcept(segmentText: string, opts?: CallOptions): Promise<string>;
  /**
   * The card rewritten in `language` (never 'en'): same meaning, math notation untouched, and the
   * four options in the same order, so the stored English card's answerIdx still grades it. The
   * returned answerIdx is always the source card's (the model is never asked for it).
   * Optional: without it, help stays in English (with a note).
   */
  localizeHelp?(card: HelpCardCore, language: LanguageCode, opts?: CallOptions): Promise<HelpCardCore>;
  /** A spoken session recap rewritten in `language` (≤ 90 words). Optional, like localizeHelp. */
  polishRecap?(text: string, language: LanguageCode, opts?: CallOptions): Promise<string>;
}

/** The model answered, but not with something we accept (after the one repair retry). */
export class AiInvalidOutputError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
    this.name = 'AiInvalidOutputError';
  }
}

/** Network / HTTP / timeout failure talking to a provider. `status` is the HTTP status when known. */
export class AiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AiRequestError';
  }
}
