import { expect, test } from "@playwright/test";
import type { InkHotspot, InkWindowStat } from "../lib/dbShared";
import { buildPhase2Scenario } from "./fixtures/phase2-scenario";

// Storage backend endpoints: health (which backend is live) and the ink time-series statistics,
// against whichever backend the test server runs (SQLite by default; INKLING_TEST_PG=1 → Postgres).

const EVIL = { Origin: "http://evil.example" };
const expectedBackend = process.env.INKLING_TEST_PG === "1" ? "postgres" : "sqlite";

test("GET /api/health reports the backend without connection details", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toContain("no-store");
  expect(await res.json()).toEqual({ ok: true, backend: expectedBackend, timescale: false });
  expect((await request.get("/api/health", { headers: EVIL })).status()).toBe(403);
});

test("ink stats per window and class-wide hotspots follow the stored ink", async ({ request }) => {
  const created = await request.post("/api/sessions", { data: { title: "Storage stats" } });
  expect(created.status()).toBe(201);
  const { session } = (await created.json()) as { session: { id: string; lectureId: string } };
  const { strokes, eraseEvents } = buildPhase2Scenario(session.id);
  expect((await request.post(`/api/sessions/${session.id}/strokes`, { data: { strokes, eraseEvents } })).status()).toBe(200);

  const stats = await request.get(`/api/sessions/${session.id}/ink-stats?windowMs=30000`);
  expect(stats.status()).toBe(200);
  const body = (await stats.json()) as { windowMs: number; windows: InkWindowStat[] };
  expect(body.windowMs).toBe(30_000);
  expect(body.windows.length).toBeGreaterThan(3);
  expect(body.windows.every((w) => w.bucketStartMs % 30_000 === 0 && w.strokes > 0 && w.medianSpeed > 0)).toBe(true);
  const live = strokes.filter((s) => !s.replacedBy?.length && !s.isScribble).length;
  expect(body.windows.reduce((n, w) => n + w.strokes, 0)).toBe(live);

  expect((await request.get(`/api/sessions/${session.id}/ink-stats?windowMs=5`)).status()).toBe(400);
  expect((await request.get(`/api/sessions/${session.id}/ink-stats?windowMs=abc`)).status()).toBe(400);
  expect((await request.get(`/api/sessions/s_missing/ink-stats`)).status()).toBe(404);

  const hot = await request.get(`/api/lectures/${session.lectureId}/hotspots`);
  expect(hot.status()).toBe(200);
  const { bucketMs, hotspots } = (await hot.json()) as { bucketMs: number; hotspots: InkHotspot[] };
  expect(bucketMs).toBe(30_000);
  // Class-wide: at least this session's ink (other specs may have written to the same lecture).
  expect(hotspots.reduce((n, h) => n + h.strokes, 0)).toBeGreaterThanOrEqual(live);
  expect((await request.get(`/api/lectures/l_missing/hotspots`)).status()).toBe(404);
});
