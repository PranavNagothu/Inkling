// Autosave state machine for the capture page (components/SessionCapture). Client-safe and free of
// React so the save semantics are unit-tested (lib/__tests__/inkSaver.test.ts):
//
// - A change is "unsaved" until a request carrying it (at that version or newer) gets a 2xx.
//   Being in flight is not being saved: a failed request needs no re-queueing because nothing was
//   dequeued, and a stroke edited while its save was in flight stays dirty.
// - Network errors, 5xx, 408 and 429 are retried with exponential backoff ("retrying").
// - Other 4xx mean the server will refuse that exact payload again, so it is not retried forever:
//   400/413 batches are bisected to isolate the refused items, the rest are saved, and the refused
//   ones are reported ("rejected") until they change again or the student retries explicitly.
// - When the page is hidden, everything not yet confirmed (including what is in flight) is sent
//   with sendBeacon (fetch keepalive as a fallback). Re-sending is harmless: the route upserts by id.
import {
  KEEPALIVE_MAX_BYTES,
  chunkBatch,
  classifySaveFailure,
  retryDelayMs,
} from "./autosave";
import type { EraseEvent, Stroke } from "./types";

export type SaveStatus = "saved" | "unsaved" | "saving" | "retrying" | "rejected";
/** Result of one flush: everything sent was saved, a retryable failure, or something was refused. */
export type SaveOutcome = "saved" | "transient" | "rejected";

export interface InkSaverOptions {
  /** POST endpoint (the session's strokes route). */
  url: string;
  /** The current strokes (the capture page's canonical list); dirty ids are looked up here. */
  getStrokes: () => Stroke[];
  onStatus: (status: SaveStatus) => void;
  fetch?: typeof fetch;
  sendBeacon?: (url: string, data: Blob) => boolean;
  now?: () => number;
  log?: (message: string, detail?: unknown) => void;
}

/** Refused batches are split at most this deep (≤ 2^depth requests) before refusing them whole. */
const MAX_BISECT_DEPTH = 6;

const JSON_HEADERS = { "Content-Type": "application/json" };

type Versions = Map<string, number>;

export class InkSaver {
  private readonly opts: Required<Omit<InkSaverOptions, "sendBeacon">> & Pick<InkSaverOptions, "sendBeacon">;
  /** Stroke id → version of its latest unconfirmed change. */
  private readonly dirty: Versions = new Map();
  /** Erase events not yet confirmed saved, oldest first. */
  private events: EraseEvent[] = [];
  /** Stroke id → version the server refused; that version is not sent again automatically. */
  private readonly rejectedStrokes: Versions = new Map();
  private readonly rejectedEvents = new Set<string>();
  private version = 0;
  private beaconedVersion = -1;
  private inflight: Promise<SaveOutcome> | null = null;
  private attempt = 0;
  private nextAttemptAt = 0;
  private current: SaveStatus = "saved";

  constructor(options: InkSaverOptions) {
    this.opts = {
      fetch: (...args) => fetch(...args),
      now: () => Date.now(),
      log: (message, detail) => console.error(message, detail),
      ...options,
    };
  }

  get status(): SaveStatus {
    return this.current;
  }

  /** Records strokes (by id) that changed and new erase events; they stay unsaved until confirmed. */
  markChanged(strokeIds: string[], events: EraseEvent[] = []): void {
    const v = ++this.version;
    for (const id of strokeIds) {
      this.dirty.set(id, v);
      this.rejectedStrokes.delete(id); // a new version is worth sending
    }
    this.events.push(...events);
    this.emit();
  }

  /** True when something still has to be sent (refused items excluded). */
  hasUnsaved(): boolean {
    for (const [id, v] of this.dirty) if (this.rejectedStrokes.get(id) !== v) return true;
    return this.events.some((e) => !this.rejectedEvents.has(e.id));
  }

  hasRejected(): boolean {
    return this.rejectedStrokes.size > 0 || this.rejectedEvents.size > 0;
  }

  /** Autosave heartbeat: flushes when there is something to send and no backoff is pending. */
  async tick(): Promise<void> {
    if (this.inflight || !this.hasUnsaved() || this.opts.now() < this.nextAttemptAt) return;
    await this.flush();
  }

  /**
   * Sends everything unsaved (waits for a save already in flight first). `includeRejected` also
   * re-sends what the server refused before — for an explicit retry by the student.
   */
  async flush({ includeRejected = false }: { includeRejected?: boolean } = {}): Promise<SaveOutcome> {
    while (this.inflight) await this.inflight;
    if (includeRejected) {
      this.rejectedStrokes.clear();
      this.rejectedEvents.clear();
    }
    const { strokes, events, versions } = this.collect();
    if (strokes.length === 0 && events.length === 0) {
      this.emit();
      return this.hasRejected() ? "rejected" : "saved";
    }

    const run = async (): Promise<SaveOutcome> => {
      let refused = false;
      for (const chunk of chunkBatch(strokes, events)) {
        const result = await this.send(chunk.strokes, chunk.eraseEvents, versions, 0);
        if (result === "transient") return "transient";
        if (result === "rejected") refused = true;
      }
      return refused ? "rejected" : "saved";
    };
    const p = run();
    this.inflight = p;
    this.emit();
    let outcome: SaveOutcome;
    try {
      outcome = await p;
    } finally {
      this.inflight = null;
    }
    if (outcome === "transient") {
      this.nextAttemptAt = this.opts.now() + retryDelayMs(this.attempt);
      this.attempt++;
    } else {
      this.attempt = 0;
      this.nextAttemptAt = 0;
    }
    this.emit();
    if (outcome === "transient") return "transient";
    return this.hasRejected() ? "rejected" : "saved";
  }

  /**
   * Page hidden / closing: hands everything not confirmed saved to the browser (sendBeacon, or
   * fetch keepalive when the beacon is refused). Does not mark anything saved.
   */
  beaconUnsaved(): void {
    if (this.version === this.beaconedVersion) return; // nothing changed since the last beacon
    const { strokes, events } = this.collect();
    if (strokes.length === 0 && events.length === 0) return;
    this.beaconedVersion = this.version;
    const { url } = this.opts;
    for (const chunk of chunkBatch(strokes, events, { maxBytes: KEEPALIVE_MAX_BYTES })) {
      let queued = false;
      try {
        queued = this.opts.sendBeacon?.(url, new Blob([chunk.body], { type: "application/json" })) ?? false;
      } catch {
        queued = false;
      }
      if (queued) continue;
      const init = { method: "POST", headers: JSON_HEADERS, body: chunk.body };
      // keepalive fails fast when over the browser's budget; then try a plain request.
      void this.opts
        .fetch(url, { ...init, keepalive: chunk.bytes <= KEEPALIVE_MAX_BYTES })
        .catch(() => this.opts.fetch(url, init))
        .catch(() => {});
    }
  }

  /** Unsaved strokes (current version) and events, excluding what the server refused. */
  private collect(): { strokes: Stroke[]; events: EraseEvent[]; versions: Versions } {
    const byId = new Map(this.opts.getStrokes().map((s) => [s.id, s]));
    const strokes: Stroke[] = [];
    const versions: Versions = new Map();
    for (const [id, v] of this.dirty) {
      if (this.rejectedStrokes.get(id) === v) continue;
      const s = byId.get(id);
      if (!s) {
        this.dirty.delete(id); // no longer exists on the page: nothing to save
        continue;
      }
      strokes.push(s);
      versions.set(id, v);
    }
    const events = this.events.filter((e) => !this.rejectedEvents.has(e.id));
    return { strokes, events, versions };
  }

  private async send(strokes: Stroke[], events: EraseEvent[], versions: Versions, depth: number): Promise<SaveOutcome> {
    const body = JSON.stringify({ strokes, eraseEvents: events });
    const bytes = new TextEncoder().encode(body).length;
    let res: Response;
    try {
      res = await this.opts.fetch(this.opts.url, {
        method: "POST",
        headers: JSON_HEADERS,
        body,
        // Survives a page close mid-save; browsers cap keepalive bodies, so big batches go without.
        keepalive: bytes <= KEEPALIVE_MAX_BYTES,
      });
    } catch {
      return "transient";
    }
    if (res.ok) {
      this.confirm(strokes, events, versions);
      return "saved";
    }
    if (classifySaveFailure(res.status) === "transient") return "transient";

    // Refused. A content problem (400 invalid item, 413 too big) may be down to some items only.
    const items = strokes.length + events.length;
    if ((res.status === 400 || res.status === 413) && items > 1 && depth < MAX_BISECT_DEPTH) {
      const half = Math.ceil(items / 2);
      const first = await this.send(strokes.slice(0, half), events.slice(0, Math.max(0, half - strokes.length)), versions, depth + 1);
      if (first === "transient") return "transient";
      const second = await this.send(strokes.slice(half), events.slice(Math.max(0, half - strokes.length)), versions, depth + 1);
      if (second === "transient") return "transient";
      return first === "rejected" || second === "rejected" ? "rejected" : "saved";
    }
    this.opts.log(`Autosave refused (${res.status}) for ${strokes.length} stroke(s), ${events.length} erase event(s)`, {
      strokeIds: strokes.map((s) => s.id),
      eventIds: events.map((e) => e.id),
    });
    for (const s of strokes) {
      const v = versions.get(s.id);
      if (v !== undefined && this.dirty.get(s.id) === v) this.rejectedStrokes.set(s.id, v);
    }
    for (const e of events) this.rejectedEvents.add(e.id);
    return "rejected";
  }

  private confirm(strokes: Stroke[], events: EraseEvent[], versions: Versions): void {
    for (const s of strokes) {
      const v = versions.get(s.id);
      if (v !== undefined && this.dirty.get(s.id) === v) this.dirty.delete(s.id);
    }
    if (events.length > 0) {
      const sent = new Set(events.map((e) => e.id));
      this.events = this.events.filter((e) => !sent.has(e.id));
      for (const id of sent) this.rejectedEvents.delete(id);
    }
  }

  private emit(): void {
    const next: SaveStatus = this.hasRejected()
      ? "rejected"
      : this.inflight
        ? "saving"
        : this.attempt > 0
          ? "retrying"
          : this.hasUnsaved()
            ? "unsaved"
            : "saved";
    if (next === this.current) return;
    this.current = next;
    this.opts.onStatus(next);
  }
}
