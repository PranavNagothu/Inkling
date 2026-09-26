import { describe, it, expect } from 'vitest';
import { buildTimeline, applyCheckAnswer, excerptAround, CLASSIFY_CONFIG } from '../classify';
import type {
  ConfusionWindow,
  Revision,
  TranscriptWord,
  TimelineEvent,
  CheckAttempt,
  RevisionKind,
} from '../types';

function makeWindow(bucketStartMs: number, isSpike: boolean, sessionId = 's1'): ConfusionWindow {
  return {
    sessionId,
    bucketStartMs,
    pause: 0,
    slowdown: 0,
    erase: 0,
    pressure: null,
    rawScore: 0,
    emaScore: 0,
    isSpike,
    reasons: [],
  };
}

function makeRevision(
  id: string,
  lectureMs: number,
  kind: RevisionKind = 'correction',
  opts: { cosmetic?: boolean; sessionId?: string } = {},
): Revision {
  const revision: Revision = {
    id,
    sessionId: opts.sessionId ?? 's1',
    lectureMs,
    beforeStrokeIds: [],
    afterStrokeIds: [],
    bbox: [0, 0, 0, 0],
    kind,
  };
  if (opts.cosmetic !== undefined) {
    revision.vision = {
      before: 'before',
      after: 'after',
      misconception: 'misc',
      conceptLabel: 'label',
      cosmetic: opts.cosmetic,
    };
  }
  return revision;
}

function makeWord(w: string, startMs: number, endMs: number): TranscriptWord {
  return { w, startMs, endMs };
}

function makeEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: 'evt-1',
    sessionId: 's1',
    lectureMs: 10000,
    type: 'misconception_corrected',
    status: 'resolved',
    conceptId: null,
    evidence: { excerpt: '', audioStartMs: 0, audioEndMs: 20000 },
    checkAttempts: [],
    ...overrides,
  };
}

function makeAttempt(correct: boolean): CheckAttempt {
  return { atIso: '2026-01-01T00:00:00.000Z', choiceIdx: 0, correct };
}

describe('buildTimeline: linking rules', () => {
  it('links a spike to a correction inside the window and marks it misconception_corrected/resolved', () => {
    const windows = [makeWindow(60000, true)];
    const revisions = [makeRevision('r1', 65000, 'correction', { cosmetic: false })];
    const result = buildTimeline({ sessionId: 's1', windows, revisions, words: [] });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'misconception_corrected',
      status: 'resolved',
      lectureMs: 65000,
      revisionId: 'r1',
      windowStartMs: 60000,
    });
  });

  it('produces a resolved misconception_corrected event for a correction not linked to any spike', () => {
    const revisions = [makeRevision('r2', 200000, 'correction')];
    const result = buildTimeline({ sessionId: 's1', windows: [], revisions, words: [] });

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('misconception_corrected');
    expect(result[0].status).toBe('resolved');
    expect(result[0].revisionId).toBe('r2');
    expect(result[0].windowStartMs).toBeUndefined();
  });

  it('produces an open unresolved_gap for a spike with no linked correction', () => {
    const windows = [makeWindow(60000, true)];
    const result = buildTimeline({ sessionId: 's1', windows, revisions: [], words: [] });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'unresolved_gap',
      status: 'open',
      lectureMs: 60000,
      windowStartMs: 60000,
    });
    expect(result[0].revisionId).toBeUndefined();
  });

  it('ignores micro revisions entirely (no event, no linking) leaving the nearby spike an open gap', () => {
    const windows = [makeWindow(60000, true)];
    const revisions = [makeRevision('r3', 65000, 'micro')];
    const result = buildTimeline({ sessionId: 's1', windows, revisions, words: [] });

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('unresolved_gap');
  });

  it('ignores cosmetic corrections entirely (no event, no linking) leaving the nearby spike an open gap', () => {
    const windows = [makeWindow(60000, true)];
    const revisions = [makeRevision('r4', 65000, 'correction', { cosmetic: true })];
    const result = buildTimeline({ sessionId: 's1', windows, revisions, words: [] });

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('unresolved_gap');
  });

  it('treats deletions as non-links (deletion revisions never produce events or absorb spikes)', () => {
    const windows = [makeWindow(60000, true)];
    const revisions = [makeRevision('r5', 65000, 'deletion')];
    const result = buildTimeline({ sessionId: 's1', windows, revisions, words: [] });

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('unresolved_gap');
  });
});

describe('buildTimeline: one correction, several spikes', () => {
  const windows = [makeWindow(60000, true), makeWindow(100000, true)];
  const revisions = [makeRevision('r1', 95000)];

  it('links a correction to at most one spike (the closest); the other spike stays an open gap', () => {
    const result = buildTimeline({ sessionId: 's1', windows, revisions, words: [] });
    expect(result.map((e) => [e.type, e.lectureMs, e.windowStartMs, e.revisionId])).toEqual([
      ['unresolved_gap', 60000, 60000, undefined],
      ['misconception_corrected', 95000, 100000, 'r1'],
    ]);
  });

  it('never produces duplicate event ids', () => {
    const result = buildTimeline({ sessionId: 's1', windows, revisions, words: [] });
    expect(new Set(result.map((e) => e.id)).size).toBe(result.length);
  });

  it('lets the losing spike link to another correction still in its range', () => {
    const result = buildTimeline({
      sessionId: 's1',
      windows,
      revisions: [...revisions, makeRevision('r2', 70000)],
      words: [],
    });
    const linked = result.filter((e) => e.revisionId).map((e) => [e.revisionId, e.windowStartMs]);
    expect(linked).toEqual([
      ['r2', 60000],
      ['r1', 100000],
    ]);
    expect(result.some((e) => e.type === 'unresolved_gap')).toBe(false);
  });

  it('breaks a distance tie in favour of the stronger spike', () => {
    const strong = { ...makeWindow(100000, true), emaScore: 0.9 };
    const weak = { ...makeWindow(80000, true), emaScore: 0.6 };
    const result = buildTimeline({ sessionId: 's1', windows: [weak, strong], revisions: [makeRevision('r1', 90000)], words: [] });
    expect(result.find((e) => e.revisionId === 'r1')?.windowStartMs).toBe(100000);
    expect(result.find((e) => e.type === 'unresolved_gap')?.lectureMs).toBe(80000);
  });

  it('keeps ids unique for two corrections at the same lecture time', () => {
    const result = buildTimeline({
      sessionId: 's1',
      windows: [],
      revisions: [makeRevision('ra', 50000), makeRevision('rb', 50000)],
      words: [],
    });
    expect(result).toHaveLength(2);
    expect(new Set(result.map((e) => e.id)).size).toBe(2);
  });
});

describe('buildTimeline: dedupe', () => {
  it('merges events within dedupeMs sharing a conceptId, keeping the strictly more severe one', () => {
    // Unlinked correction at 100000 (misconception_corrected, sev 1); unlinked spike at
    // 115000 (unresolved_gap, sev 2). 100000 sits just outside the spike's linkBeforeMs
    // window ([105000, 160000]) so it stays unlinked, while being within dedupeMs (30000)
    // of the spike's own lectureMs.
    const windows = [makeWindow(115000, true)];
    const revisions = [makeRevision('rA', 100000, 'correction')];
    const result = buildTimeline({
      sessionId: 's1',
      windows,
      revisions,
      words: [],
      conceptFor: () => 'C1',
    });

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('unresolved_gap');
    expect(result[0].lectureMs).toBe(115000);
  });

  it('keeps the earlier event on a severity tie and discards the later duplicate', () => {
    const revisions = [makeRevision('rX', 50000, 'correction'), makeRevision('rY', 60000, 'correction')];
    const result = buildTimeline({
      sessionId: 's1',
      windows: [],
      revisions,
      words: [],
      conceptFor: () => 'C1',
    });

    expect(result).toHaveLength(1);
    expect(result[0].revisionId).toBe('rX');
    expect(result[0].lectureMs).toBe(50000);
  });

  it('does not merge events with different conceptIds even when close in time', () => {
    const revisions = [makeRevision('rX2', 50000, 'correction'), makeRevision('rY2', 60000, 'correction')];
    const result = buildTimeline({
      sessionId: 's1',
      windows: [],
      revisions,
      words: [],
      conceptFor: (ms) => (ms < 55000 ? 'C1' : 'C2'),
    });

    expect(result).toHaveLength(2);
  });
});

describe('buildTimeline: concept labels', () => {
  it('stores the id and readable label when conceptFor returns a concept segment', () => {
    const windows = [makeWindow(60000, true)];
    const result = buildTimeline({
      sessionId: 's1',
      windows,
      revisions: [],
      words: [],
      conceptFor: (ms) => ({ id: `lec@${ms}`, label: 'The chain rule tells us' }),
    });
    expect(result[0]).toMatchObject({ conceptId: 'lec@60000', conceptLabel: 'The chain rule tells us' });
  });

  it('a plain string id leaves the label null', () => {
    const result = buildTimeline({ sessionId: 's1', windows: [makeWindow(60000, true)], revisions: [], words: [], conceptFor: () => 'C1' });
    expect(result[0]).toMatchObject({ conceptId: 'C1', conceptLabel: null });
  });
});

describe('buildTimeline: cap', () => {
  it('caps output at maxEvents, prioritizing unresolved_gap over misconception_corrected', () => {
    const windows: ConfusionWindow[] = [];
    for (let i = 0; i < 12; i++) {
      windows.push(makeWindow(i * 100000, true));
    }
    const revisions: Revision[] = [
      makeRevision('c1', 10000000, 'correction'),
      makeRevision('c2', 10100000, 'correction'),
      makeRevision('c3', 10200000, 'correction'),
    ];

    const result = buildTimeline({ sessionId: 's1', windows, revisions, words: [] });

    expect(result).toHaveLength(10);
    expect(result.every((e) => e.type === 'unresolved_gap')).toBe(true);
    expect(result.map((e) => e.lectureMs)).toEqual([0, 100000, 200000, 300000, 400000, 500000, 600000, 700000, 800000, 900000]);
  });
});

describe('excerptAround', () => {
  it('joins only words overlapping the padded window', () => {
    const words = [makeWord('alpha', 0, 1000), makeWord('beta', 5000, 6000), makeWord('gamma', 20000, 21000)];
    expect(excerptAround(words, 5000, 3000)).toBe('beta');
  });

  it('joins multiple overlapping words in order', () => {
    const words = [makeWord('one', 1000, 2000), makeWord('two', 3000, 4000), makeWord('three', 10000, 11000)];
    expect(excerptAround(words, 3000, 2000)).toBe('one two');
  });
});

describe('buildTimeline: evidence', () => {
  it('computes evidence excerpt and audio bounds using the configured pads', () => {
    const revisions = [makeRevision('rE', 50000, 'correction')];
    const words = [makeWord('hello', 49000, 49500)];
    const result = buildTimeline({ sessionId: 's1', windows: [], revisions, words });

    expect(result[0].evidence.audioStartMs).toBe(40000);
    expect(result[0].evidence.audioEndMs).toBe(60000);
    expect(result[0].evidence.excerpt).toBe('hello');
  });

  it('clamps audioStartMs to 0 near the start of the lecture', () => {
    const revisions = [makeRevision('rF', 5000, 'correction')];
    const result = buildTimeline({ sessionId: 's1', windows: [], revisions, words: [] });

    expect(result[0].evidence.audioStartMs).toBe(0);
    expect(result[0].evidence.audioEndMs).toBe(15000);
  });
});

describe('buildTimeline: ordering, determinism, purity', () => {
  it('returns events sorted ascending by lectureMs regardless of input order', () => {
    const revisions = [makeRevision('rLate', 90000, 'correction'), makeRevision('rEarly', 10000, 'correction')];
    const result = buildTimeline({ sessionId: 's1', windows: [], revisions, words: [] });

    expect(result.map((e) => e.lectureMs)).toEqual([10000, 90000]);
  });

  it('produces deterministic ids across repeated calls with identical input', () => {
    const revisions = [makeRevision('rDet', 30000, 'correction')];
    const result1 = buildTimeline({ sessionId: 's1', windows: [], revisions, words: [] });
    const result2 = buildTimeline({ sessionId: 's1', windows: [], revisions, words: [] });

    expect(result1[0].id).toBe(result2[0].id);
  });

  it('does not mutate its input windows, revisions, or words', () => {
    const windows = [makeWindow(60000, true)];
    const revisions = [makeRevision('rP', 65000, 'correction')];
    const words = [makeWord('hi', 0, 100)];
    const windowsSnapshot = JSON.parse(JSON.stringify(windows));
    const revisionsSnapshot = JSON.parse(JSON.stringify(revisions));
    const wordsSnapshot = JSON.parse(JSON.stringify(words));

    buildTimeline({ sessionId: 's1', windows, revisions, words });

    expect(windows).toEqual(windowsSnapshot);
    expect(revisions).toEqual(revisionsSnapshot);
    expect(words).toEqual(wordsSnapshot);
  });
});

describe('applyCheckAnswer', () => {
  it('promotes misconception_corrected with no prior attempts to breakthrough on a correct answer', () => {
    const event = makeEvent({ type: 'misconception_corrected', status: 'resolved', checkAttempts: [] });
    const result = applyCheckAnswer(event, makeAttempt(true));

    expect(result.type).toBe('breakthrough');
    expect(result.status).toBe('resolved');
    expect(result.checkAttempts).toHaveLength(1);
  });

  it('keeps type as misconception_corrected (no breakthrough) when there are prior attempts', () => {
    const event = makeEvent({
      type: 'misconception_corrected',
      status: 'resolved',
      checkAttempts: [makeAttempt(false)],
    });
    const result = applyCheckAnswer(event, makeAttempt(true));

    expect(result.type).toBe('misconception_corrected');
    expect(result.status).toBe('resolved');
    expect(result.checkAttempts).toHaveLength(2);
  });

  it('resolves an unresolved_gap on a correct answer without changing its type', () => {
    const event = makeEvent({ type: 'unresolved_gap', status: 'open', checkAttempts: [] });
    const result = applyCheckAnswer(event, makeAttempt(true));

    expect(result.type).toBe('unresolved_gap');
    expect(result.status).toBe('resolved');
  });

  it('marks the event unresolved_gap/open on a wrong answer, overriding a prior breakthrough', () => {
    const event = makeEvent({ type: 'breakthrough', status: 'resolved', checkAttempts: [makeAttempt(true)] });
    const result = applyCheckAnswer(event, makeAttempt(false));

    expect(result.type).toBe('unresolved_gap');
    expect(result.status).toBe('open');
    expect(result.checkAttempts).toHaveLength(2);
  });

  it('records a correct answer on a gap as resolvedBy "check" (Phase 6 progress)', () => {
    const event = makeEvent({ type: 'unresolved_gap', status: 'open', checkAttempts: [] });
    const attempt = makeAttempt(true);
    const result = applyCheckAnswer(event, attempt);
    expect(result).toMatchObject({ status: 'resolved', resolvedBy: 'check', resolvedAtIso: attempt.atIso });
  });

  it('a wrong answer clears any earlier resolution', () => {
    const event = makeEvent({
      type: 'unresolved_gap',
      status: 'resolved',
      resolvedBy: 'revisit',
      resolvedInSessionId: 's2',
      resolvedAtIso: '2026-09-26T00:00:00.000Z',
      checkAttempts: [],
    });
    const result = applyCheckAnswer(event, makeAttempt(false));
    expect(result.status).toBe('open');
    expect(result.resolvedBy).toBeUndefined();
    expect(result.resolvedInSessionId).toBeUndefined();
    expect(result.resolvedAtIso).toBeUndefined();
  });

  it('a wrong answer marks the moment reopened at the attempt time (earlier revisits no longer count)', () => {
    const event = makeEvent({
      type: 'unresolved_gap',
      status: 'resolved',
      resolvedBy: 'revisit',
      resolvedInSessionId: 's2',
      resolvedAtIso: '2026-09-26T00:00:00.000Z',
      checkAttempts: [],
    });
    const attempt = { atIso: '2026-09-27T09:30:00.000Z', choiceIdx: 2, correct: false };
    const result = applyCheckAnswer(event, attempt);
    expect(result).toMatchObject({ type: 'unresolved_gap', status: 'open', reopenedAtIso: attempt.atIso });
  });

  it('a wrong answer on a corrected moment reopens it as a gap with reopenedAtIso', () => {
    const event = makeEvent({ type: 'misconception_corrected', status: 'resolved', checkAttempts: [] });
    const attempt = { atIso: '2026-09-27T10:00:00.000Z', choiceIdx: 0, correct: false };
    expect(applyCheckAnswer(event, attempt)).toMatchObject({ type: 'unresolved_gap', status: 'open', reopenedAtIso: attempt.atIso });
  });

  it('a correct answer keeps an earlier reopenedAtIso (history) and resolves by check', () => {
    const event = makeEvent({ type: 'unresolved_gap', status: 'open', reopenedAtIso: '2026-09-27T09:30:00.000Z', checkAttempts: [] });
    const attempt = { atIso: '2026-09-27T09:31:00.000Z', choiceIdx: 1, correct: true };
    expect(applyCheckAnswer(event, attempt)).toMatchObject({
      status: 'resolved',
      resolvedBy: 'check',
      resolvedAtIso: attempt.atIso,
      reopenedAtIso: '2026-09-27T09:30:00.000Z',
    });
  });

  it('is pure: does not mutate the original event or its checkAttempts array', () => {
    const event = makeEvent({ type: 'unresolved_gap', status: 'open', checkAttempts: [] });
    const snapshot = JSON.parse(JSON.stringify(event));

    applyCheckAnswer(event, makeAttempt(true));

    expect(event).toEqual(snapshot);
    expect(event.checkAttempts).toHaveLength(0);
  });
});

describe('CLASSIFY_CONFIG', () => {
  it('exposes the documented defaults', () => {
    expect(CLASSIFY_CONFIG).toEqual({
      linkBeforeMs: 10000,
      linkAfterMs: 45000,
      dedupeMs: 30000,
      maxEvents: 10,
      evidencePadMs: 10000,
      excerptPadMs: 15000,
    });
  });
});
