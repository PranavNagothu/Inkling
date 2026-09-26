import { describe, expect, it } from 'vitest';
import {
  PROGRESS_CONFIG,
  applySelfAction,
  buildThreads,
  historyLine,
  ordinal,
  reconcileGaps,
  type SessionGaps,
} from '../progress';
import type { TimeRange, TimelineEvent } from '../types';

// Segments are 20 s long sentences: 200–220 s, 220–240 s, …
const segmentFor = (ms: number): TimeRange => {
  const startMs = Math.floor(ms / 20_000) * 20_000;
  return { startMs, endMs: startMs + 20_000 };
};

function gap(sessionId: string, lectureMs: number, extra: Partial<TimelineEvent> = {}): TimelineEvent {
  const seg = segmentFor(lectureMs);
  return {
    id: `${sessionId}:unresolved_gap:${lectureMs}`,
    sessionId,
    lectureMs,
    type: 'unresolved_gap',
    status: 'open',
    conceptId: `lec@${seg.startMs}`,
    conceptLabel: 'Some sentence',
    evidence: { excerpt: '', audioStartMs: 0, audioEndMs: 0 },
    checkAttempts: [],
    ...extra,
  };
}

/** `count` 1.2 s strokes every 2.5 s from `fromMs`. */
function ink(fromMs: number, toMs: number): TimeRange[] {
  const out: TimeRange[] = [];
  for (let t = fromMs; t < toMs; t += 2500) out.push({ startMs: t, endMs: t + 1200 });
  return out;
}

function session(id: string, day: number, inkSpans: TimeRange[], gaps: TimelineEvent[] = []): SessionGaps {
  return { sessionId: id, createdAtIso: `2026-09-${String(day).padStart(2, '0')}T10:00:00.000Z`, inkSpans, gaps };
}

const byId = (list: TimelineEvent[]) => new Map(list.map((g) => [g.id, g]));

describe('reconcileGaps — revisit', () => {
  it('resolves an earlier gap when a later session writes calmly through its segment', () => {
    const g1 = gap('s1', 220_000);
    const out = byId(
      reconcileGaps([session('s1', 25, ink(0, 300_000), [g1]), session('s2', 26, ink(150_000, 260_000))], segmentFor),
    );
    expect(out.get(g1.id)).toMatchObject({
      status: 'resolved',
      resolvedBy: 'revisit',
      resolvedInSessionId: 's2',
      resolvedAtIso: '2026-09-26T10:00:00.000Z',
    });
  });

  it('counts ink within ±15 s of the segment (mid-lecture start just after it)', () => {
    const g1 = gap('s1', 220_000); // segment 220–240 s
    const pad = PROGRESS_CONFIG.revisitPadMs;
    const out = byId(
      reconcileGaps([session('s1', 25, [], [g1]), session('s2', 26, ink(240_000 + pad - 5000, 400_000))], segmentFor),
    );
    expect(out.get(g1.id)!.status).toBe('resolved');
  });

  it('stays open when the later session never wrote there', () => {
    const g1 = gap('s1', 220_000);
    const out = byId(reconcileGaps([session('s1', 25, [], [g1]), session('s2', 26, ink(0, 150_000))], segmentFor));
    expect(out.get(g1.id)).toMatchObject({ status: 'open' });
    expect(out.get(g1.id)!.resolvedBy).toBeUndefined();
  });

  it('needs more than a single stray stroke', () => {
    const g1 = gap('s1', 220_000);
    const out = byId(
      reconcileGaps([session('s1', 25, [], [g1]), session('s2', 26, [{ startMs: 225_000, endMs: 225_500 }])], segmentFor),
    );
    expect(out.get(g1.id)!.status).toBe('open');
  });

  it('never resolves from an earlier session (only LATER ones count)', () => {
    const g2 = gap('s2', 220_000);
    const out = byId(reconcileGaps([session('s1', 25, ink(0, 300_000)), session('s2', 26, [], [g2])], segmentFor));
    expect(out.get(g2.id)!.status).toBe('open');
  });

  it('a repeat gap keeps the earlier one open and links to it (2nd time)', () => {
    const g1 = gap('s1', 220_000);
    const g2 = gap('s2', 230_000);
    const out = byId(
      reconcileGaps([session('s1', 25, ink(0, 300_000), [g1]), session('s2', 26, ink(0, 300_000), [g2])], segmentFor),
    );
    expect(out.get(g1.id)!.status).toBe('open');
    expect(out.get(g2.id)).toMatchObject({ status: 'open', repeatOf: g1.id });
  });

  it('a repeat within ±15 s of the segment (different sentence) still counts as the same spot', () => {
    const g1 = gap('s1', 220_000); // segment 220–240
    const g2 = gap('s2', 250_000); // different segment, but within 240 + 15 s
    const out = byId(reconcileGaps([session('s1', 25, [], [g1]), session('s2', 26, ink(0, 300_000), [g2])], segmentFor));
    expect(out.get(g1.id)!.status).toBe('open');
    expect(out.get(g2.id)!.repeatOf).toBe(g1.id);
  });

  it('a third calm session resolves both the gap and its repeat', () => {
    const g1 = gap('s1', 220_000);
    const g2 = gap('s2', 220_000);
    const out = byId(
      reconcileGaps(
        [session('s1', 24, [], [g1]), session('s2', 25, ink(0, 300_000), [g2]), session('s3', 26, ink(180_000, 300_000))],
        segmentFor,
      ),
    );
    expect(out.get(g1.id)).toMatchObject({ status: 'resolved', resolvedInSessionId: 's3' });
    expect(out.get(g2.id)).toMatchObject({ status: 'resolved', resolvedInSessionId: 's3', repeatOf: g1.id });
  });

  it('is idempotent: reconciling its own output changes nothing', () => {
    const sessions = [
      session('s1', 24, ink(0, 300_000), [gap('s1', 220_000), gap('s1', 60_000)]),
      session('s2', 25, ink(0, 300_000), [gap('s2', 60_000)]),
      session('s3', 26, ink(180_000, 300_000)),
    ];
    const once = reconcileGaps(sessions, segmentFor);
    const again = reconcileGaps(
      sessions.map((s) => ({ ...s, gaps: once.filter((g) => g.sessionId === s.sessionId) })),
      segmentFor,
    );
    expect(again).toEqual(once);
  });

  it('re-evaluates a revisit resolution (no flip-flop, but it follows the evidence)', () => {
    // Previously resolved by s2; s2 now has a gap there (e.g. re-analysis after more ink) → reopens.
    const g1 = gap('s1', 220_000, {
      status: 'resolved',
      resolvedBy: 'revisit',
      resolvedInSessionId: 's2',
      resolvedAtIso: '2026-09-26T10:00:00.000Z',
    });
    const out = byId(
      reconcileGaps([session('s1', 25, [], [g1]), session('s2', 26, ink(0, 300_000), [gap('s2', 220_000)])], segmentFor),
    );
    const g = out.get(g1.id)!;
    expect(g.status).toBe('open');
    expect(g.resolvedBy).toBeUndefined();
    expect(g.resolvedInSessionId).toBeUndefined();
    expect(g.resolvedAtIso).toBeUndefined();
  });

  it('keeps self and check resolutions untouched', () => {
    const self = gap('s1', 220_000, { status: 'resolved', resolvedBy: 'self', resolvedAtIso: '2026-09-25T12:00:00.000Z' });
    const check = gap('s1', 100_000, { status: 'resolved', resolvedBy: 'check', resolvedAtIso: '2026-09-25T12:00:00.000Z' });
    const out = byId(
      reconcileGaps(
        [session('s1', 25, [], [self, check]), session('s2', 26, ink(0, 300_000), [gap('s2', 220_000), gap('s2', 100_000)])],
        segmentFor,
      ),
    );
    expect(out.get(self.id)).toMatchObject({ status: 'resolved', resolvedBy: 'self' });
    expect(out.get(check.id)).toMatchObject({ status: 'resolved', resolvedBy: 'check' });
  });

  it('after "Still confused", only sessions started later can resolve it', () => {
    const g1 = gap('s1', 220_000, { reopenedAtIso: '2026-09-26T12:00:00.000Z' });
    const sessions = [session('s1', 25, [], [g1]), session('s2', 26, ink(0, 300_000))]; // s2 started 10:00 on the 26th
    expect(byId(reconcileGaps(sessions, segmentFor)).get(g1.id)!.status).toBe('open');
    const later = [...sessions, session('s3', 27, ink(0, 300_000))];
    expect(byId(reconcileGaps(later, segmentFor)).get(g1.id)).toMatchObject({
      status: 'resolved',
      resolvedInSessionId: 's3',
    });
  });

  it('orders sessions by start time, not input order', () => {
    const g1 = gap('s1', 220_000);
    const out = byId(reconcileGaps([session('s2', 26, ink(0, 300_000)), session('s1', 25, [], [g1])], segmentFor));
    expect(out.get(g1.id)!.status).toBe('resolved');
  });

  it('does not mutate its input', () => {
    const g1 = gap('s1', 220_000);
    const sessions = [session('s1', 25, [], [g1]), session('s2', 26, ink(0, 300_000))];
    const snapshot = JSON.parse(JSON.stringify(sessions));
    reconcileGaps(sessions, segmentFor);
    expect(sessions).toEqual(snapshot);
  });
});

describe('applySelfAction', () => {
  const now = '2026-09-26T15:00:00.000Z';

  it('"I get it now" resolves an open gap', () => {
    const g1 = gap('s1', 220_000);
    const changed = applySelfAction([g1], g1.id, 'self', now);
    expect(changed).toEqual([{ ...g1, status: 'resolved', resolvedBy: 'self', resolvedAtIso: now }]);
  });

  it('"I get it now" also resolves the earlier open gaps it repeats (the whole thread so far)', () => {
    const g1 = gap('s1', 220_000);
    const g2 = gap('s2', 220_000, { repeatOf: g1.id });
    const other = gap('s1', 60_000);
    const changed = applySelfAction([g1, g2, other], g2.id, 'self', now);
    expect(changed.map((g) => g.id).sort()).toEqual([g1.id, g2.id].sort());
    expect(changed.every((g) => g.status === 'resolved' && g.resolvedBy === 'self')).toBe(true);
  });

  it('"I get it now" on a resolved gap is a no-op', () => {
    const g1 = gap('s1', 220_000, { status: 'resolved', resolvedBy: 'revisit', resolvedInSessionId: 's2' });
    expect(applySelfAction([g1], g1.id, 'self', now)).toEqual([]);
  });

  it('"Still confused" reopens a resolved gap and remembers when', () => {
    const g1 = gap('s1', 220_000, {
      status: 'resolved',
      resolvedBy: 'revisit',
      resolvedInSessionId: 's2',
      resolvedAtIso: '2026-09-26T10:00:00.000Z',
    });
    const [re] = applySelfAction([g1], g1.id, 'reopen', now);
    expect(re.status).toBe('open');
    expect(re.reopenedAtIso).toBe(now);
    expect(re.resolvedBy).toBeUndefined();
    expect(re.resolvedInSessionId).toBeUndefined();
    expect(re.resolvedAtIso).toBeUndefined();
  });

  it('"Still confused" on an open gap changes nothing', () => {
    const g1 = gap('s1', 220_000);
    expect(applySelfAction([g1], g1.id, 'reopen', now)).toEqual([]);
  });

  it('self then reopen then reconcile stays open (a revisit before the reopen no longer counts)', () => {
    const g1 = gap('s1', 220_000);
    const [resolved] = applySelfAction([g1], g1.id, 'self', '2026-09-25T12:00:00.000Z');
    const [reopened] = applySelfAction([resolved], g1.id, 'reopen', now);
    const out = reconcileGaps([session('s1', 25, [], [reopened]), session('s2', 26, ink(0, 300_000))], segmentFor);
    expect(out[0].status).toBe('open');
  });

  it('throws for an unknown id or a non-gap', () => {
    expect(() => applySelfAction([], 'nope', 'self', now)).toThrow();
    const corrected = { ...gap('s1', 1000), type: 'misconception_corrected' as const };
    expect(() => applySelfAction([corrected], corrected.id, 'self', now)).toThrow();
  });
});

describe('buildThreads', () => {
  const sessions = new Map([
    ['s1', { id: 's1', lectureId: 'lec', createdAtIso: '2026-09-25T10:00:00.000Z' }],
    ['s2', { id: 's2', lectureId: 'lec', createdAtIso: '2026-09-26T10:00:00.000Z' }],
  ]);

  it('groups a gap and its repeat into one thread with occurrences and first-seen', () => {
    const g1 = gap('s1', 220_000);
    const g2 = gap('s2', 220_000, { repeatOf: g1.id });
    const g3 = gap('s1', 60_000, { status: 'resolved', resolvedBy: 'self', resolvedAtIso: '2026-09-25T11:00:00.000Z' });
    const threads = buildThreads([g2, g3, g1], sessions);
    expect(threads).toHaveLength(2);
    const t = threads.find((th) => th.rootId === g1.id)!;
    expect(t).toMatchObject({
      lectureId: 'lec',
      status: 'open',
      firstSeenIso: '2026-09-25T10:00:00.000Z',
      label: 'Some sentence',
    });
    expect(t.gaps.map((g) => g.id)).toEqual([g1.id, g2.id]);
    expect(t.latest.id).toBe(g2.id);
    expect(t.history.get(g2.id)).toEqual({
      firstSeenIso: '2026-09-25T10:00:00.000Z',
      occurrence: 2,
      occurrences: 2,
      threadStatus: 'open',
    });
    const resolved = threads.find((th) => th.rootId === g3.id)!;
    expect(resolved).toMatchObject({ status: 'resolved', resolvedBy: 'self', resolvedAtIso: '2026-09-25T11:00:00.000Z' });
  });

  it('treats a repeatOf pointing at a vanished gap as a new thread', () => {
    const g2 = gap('s2', 220_000, { repeatOf: 'gone' });
    const [t] = buildThreads([g2], sessions);
    expect(t.rootId).toBe(g2.id);
    expect(t.history.get(g2.id)!.occurrence).toBe(1);
  });
});

describe('history text', () => {
  const fmt = (iso: string) => iso.slice(5, 10);

  it('ordinal', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual([
      '1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd',
    ]);
  });

  it('describes an open repeat', () => {
    expect(
      historyLine(gap('s2', 1, { history: { firstSeenIso: '2026-09-25T10:00:00Z', occurrence: 2, occurrences: 2, threadStatus: 'open' } }), fmt),
    ).toBe('Open since 09-25 · 2nd time');
  });

  it('describes how it was resolved', () => {
    const h = { firstSeenIso: '2026-09-25T10:00:00Z', occurrence: 1, occurrences: 1, threadStatus: 'resolved' as const };
    expect(
      historyLine(gap('s1', 1, { status: 'resolved', resolvedBy: 'revisit', resolvedAtIso: '2026-09-26T10:00:00Z', history: h }), fmt),
    ).toBe('First seen 09-25 · resolved 09-26 by writing through it calmly');
    expect(
      historyLine(gap('s1', 1, { status: 'resolved', resolvedBy: 'self', resolvedAtIso: '2026-09-26T10:00:00Z', history: h }), fmt),
    ).toBe('First seen 09-25 · resolved 09-26 — you said you get it');
  });
});
