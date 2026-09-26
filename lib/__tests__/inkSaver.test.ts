import { describe, expect, it, vi } from 'vitest';
import { KEEPALIVE_MAX_BYTES } from '../autosave';
import { buildStroke } from '../ink';
import { InkSaver, type SaveStatus } from '../inkSaver';
import type { EraseEvent, Point, Stroke } from '../types';

const URL_ = '/api/sessions/s1/strokes';
const pts = (n: number): Point[] => Array.from({ length: n }, (_, i) => [i, i % 5, 0.5, i * 4] as Point);
const mk = (id: string, n = 5): Stroke => buildStroke(id, 's1', pts(n), 'mouse');
const ev = (id: string): EraseEvent => ({ id, sessionId: 's1', atMs: 5, strokeIds: ['a'], by: 'eraser' });

type Reply = number | 'network' | Promise<number>;

function setup(replies: Reply[] | ((body: { strokes: Stroke[]; eraseEvents: EraseEvent[] }) => Reply) = [200]) {
  let strokes: Stroke[] = [];
  const statuses: SaveStatus[] = [];
  let clock = 0;
  const queue = Array.isArray(replies) ? [...replies] : null;
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const reply = queue ? (queue.length > 1 ? queue.shift()! : queue[0]) : (replies as (b: typeof body) => Reply)(body);
    const status = await reply;
    if (status === 'network') throw new TypeError('Failed to fetch');
    return new Response('{}', { status: status as number });
  });
  const beacon = vi.fn((_url: string, _data: Blob) => true);
  const saver = new InkSaver({
    url: URL_,
    getStrokes: () => strokes,
    onStatus: (s) => statuses.push(s),
    fetch: fetchMock as unknown as typeof fetch,
    sendBeacon: beacon,
    now: () => clock,
    log: () => {},
  });
  const sent = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init.body)) as { strokes: Stroke[]; eraseEvents: EraseEvent[] });
  return {
    saver,
    fetchMock,
    beacon,
    statuses,
    sent,
    setStrokes: (next: Stroke[]) => (strokes = next),
    advance: (ms: number) => (clock += ms),
  };
}

describe('InkSaver', () => {
  it('keeps changes unsaved while the request is in flight and clears them only after a 200', async () => {
    let release!: (status: number) => void;
    const t = setup([new Promise<number>((r) => (release = r))]);
    t.setStrokes([mk('a')]);
    t.saver.markChanged(['a'], [ev('e1')]);
    expect(t.saver.hasUnsaved()).toBe(true);

    const done = t.saver.flush();
    await Promise.resolve();
    expect(t.saver.status).toBe('saving');
    expect(t.saver.hasUnsaved()).toBe(true); // in flight is not saved
    release(200);
    expect(await done).toBe('saved');
    expect(t.saver.hasUnsaved()).toBe(false);
    expect(t.saver.status).toBe('saved');
    expect(t.sent()[0]).toMatchObject({ strokes: [{ id: 'a' }], eraseEvents: [{ id: 'e1' }] });
  });

  it('keeps a stroke edited during the save dirty (its newer version still has to go)', async () => {
    let release!: (status: number) => void;
    const t = setup([new Promise<number>((r) => (release = r)), 200]);
    t.setStrokes([mk('a')]);
    t.saver.markChanged(['a']);
    const done = t.saver.flush();
    await Promise.resolve();
    t.setStrokes([{ ...mk('a'), erased: true, erasedAtMs: 9, erasedBy: 'undo' }]);
    t.saver.markChanged(['a']);
    release(200);
    await done;
    expect(t.saver.hasUnsaved()).toBe(true);
    await t.saver.flush();
    expect(t.sent()[1].strokes[0].erased).toBe(true);
    expect(t.saver.hasUnsaved()).toBe(false);
  });

  it('retries network errors and 5xx with backoff, then ends saved', async () => {
    const t = setup(['network', 503, 200]);
    t.setStrokes([mk('a')]);
    t.saver.markChanged(['a']);
    expect(await t.saver.flush()).toBe('transient');
    expect(t.saver.status).toBe('retrying');
    expect(t.saver.hasUnsaved()).toBe(true);

    t.saver.tick(); // not due yet (1 s backoff)
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
    t.advance(1000);
    await t.saver.tick();
    expect(t.fetchMock).toHaveBeenCalledTimes(2);
    expect(t.saver.status).toBe('retrying');
    t.advance(1999);
    await t.saver.tick(); // second backoff is 2 s
    expect(t.fetchMock).toHaveBeenCalledTimes(2);
    t.advance(1);
    await t.saver.tick();
    expect(t.fetchMock).toHaveBeenCalledTimes(3);
    expect(t.saver.status).toBe('saved');
    expect(t.sent().every((b) => b.strokes[0].id === 'a')).toBe(true);
  });

  it('does not retry a payload the server refused (4xx): reports it and stops', async () => {
    const t = setup([400]);
    t.setStrokes([mk('a')]);
    t.saver.markChanged(['a']);
    expect(await t.saver.flush()).toBe('rejected');
    expect(t.saver.status).toBe('rejected');
    t.advance(60_000);
    await t.saver.tick();
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
    expect(t.saver.hasUnsaved()).toBe(false);
    expect(t.saver.hasRejected()).toBe(true);
  });

  it('isolates the one bad stroke in a refused batch and saves the rest', async () => {
    const t = setup((body) => (body.strokes.some((s) => s.id === 'bad') ? 400 : 200));
    t.setStrokes([mk('a'), mk('bad'), mk('c'), mk('d')]);
    t.saver.markChanged(['a', 'bad', 'c', 'd']);
    expect(await t.saver.flush()).toBe('rejected');
    expect(t.saver.hasRejected()).toBe(true);
    expect(t.saver.hasUnsaved()).toBe(false);
    const saved = t.sent().filter((b) => !b.strokes.some((s) => s.id === 'bad')).flatMap((b) => b.strokes.map((s) => s.id));
    expect(saved.sort()).toEqual(['a', 'c', 'd']);
  });

  it('a refused stroke is sent again once it changes, or when the student retries', async () => {
    const t = setup([400, 400, 200]);
    t.setStrokes([mk('a')]);
    t.saver.markChanged(['a']);
    await t.saver.flush();
    t.saver.markChanged(['a']); // edited again: a new version is worth trying
    expect(t.saver.hasRejected()).toBe(false);
    expect(await t.saver.flush()).toBe('rejected');
    expect(await t.saver.flush({ includeRejected: true })).toBe('saved');
    expect(t.saver.status).toBe('saved');
  });

  it('refuses a whole batch at once for errors not about its content (e.g. 404)', async () => {
    const t = setup([404]);
    t.setStrokes([mk('a'), mk('b'), mk('c')]);
    t.saver.markChanged(['a', 'b', 'c']);
    expect(await t.saver.flush()).toBe('rejected');
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses keepalive for requests that fit the browser keepalive budget only', async () => {
    const t = setup([200]);
    t.setStrokes([mk('small')]);
    t.saver.markChanged(['small']);
    await t.saver.flush();
    t.setStrokes([mk('big', 6000)]);
    t.saver.markChanged(['big']);
    await t.saver.flush();
    const [small, big] = t.fetchMock.mock.calls.map(([, init]) => init);
    expect(String(small.body).length).toBeLessThan(KEEPALIVE_MAX_BYTES);
    expect(small.keepalive).toBe(true);
    expect(String(big.body).length).toBeGreaterThan(KEEPALIVE_MAX_BYTES);
    expect(big.keepalive).toBe(false);
  });

  it('on hide beacons everything not confirmed saved, including what is in flight', async () => {
    let release!: (status: number) => void;
    const t = setup([new Promise<number>((r) => (release = r))]);
    t.setStrokes([mk('a'), mk('b')]);
    t.saver.markChanged(['a']);
    const done = t.saver.flush();
    await Promise.resolve();
    t.saver.markChanged(['b'], [ev('e1')]);
    t.saver.beaconUnsaved();
    expect(t.beacon).toHaveBeenCalledTimes(1);
    const body = JSON.parse(await (t.beacon.mock.calls[0][1] as Blob).text());
    expect(body.strokes.map((s: Stroke) => s.id)).toEqual(['a', 'b']);
    expect(body.eraseEvents.map((e: EraseEvent) => e.id)).toEqual(['e1']);
    // A beacon is not a confirmation.
    expect(t.saver.hasUnsaved()).toBe(true);
    // Nothing new since: a second hide (pagehide after visibilitychange) sends nothing more.
    t.saver.beaconUnsaved();
    expect(t.beacon).toHaveBeenCalledTimes(1);
    release(200);
    await done;
  });

  it('falls back to fetch keepalive when sendBeacon refuses the data', async () => {
    const t = setup([200]);
    t.beacon.mockReturnValue(false);
    t.setStrokes([mk('a')]);
    t.saver.markChanged(['a']);
    t.saver.beaconUnsaved();
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
    expect(t.fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', keepalive: true });
  });
});
