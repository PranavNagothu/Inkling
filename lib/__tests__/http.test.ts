import { describe, expect, it, vi } from 'vitest';
import { isSameOrigin, readBodyText, readJsonBody, sameOriginOnly } from '../http';

const post = (headers: Record<string, string> = {}, body?: BodyInit) =>
  new Request('http://localhost:3100/api/x', { method: 'POST', headers: { host: 'localhost:3100', ...headers }, body });

/** A body with no Content-Length: `n` chunks of `size` bytes each. */
function streamed(n: number, size: number): Request {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (sent++ >= n) return ctrl.close();
      ctrl.enqueue(new Uint8Array(size).fill(0x20));
    },
  });
  return new Request('http://localhost:3100/api/x', {
    method: 'POST',
    headers: { host: 'localhost:3100' },
    body: stream,
    duplex: 'half',
  } as RequestInit);
}

describe('isSameOrigin / sameOriginOnly', () => {
  it('allows same-origin browser requests and clients that send no Origin', () => {
    expect(isSameOrigin(post({ origin: 'http://localhost:3100' }))).toBe(true);
    expect(isSameOrigin(post())).toBe(true);
    expect(isSameOrigin(post({ origin: 'http://evil.example' }))).toBe(false);
    expect(isSameOrigin(post({ origin: 'null' }))).toBe(false);
  });

  it('answers 403 without running the handler for a cross-site request', async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const guarded = sameOriginOnly(handler);
    const res = await guarded(post({ origin: 'http://evil.example' }));
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect((await guarded(post({ origin: 'http://localhost:3100' }))).status).toBe(200);
  });

  it('passes the route context through', async () => {
    const guarded = sameOriginOnly(async (_req: Request, ctx: { id: string }) => Response.json(ctx));
    expect(await (await guarded(post(), { id: 'abc' })).json()).toEqual({ id: 'abc' });
  });
});

describe('readBodyText / readJsonBody', () => {
  it('reads a body within the limit', async () => {
    expect(await readBodyText(post({}, 'hello'), 10)).toEqual({ ok: true, value: 'hello' });
    expect(await readJsonBody(post({}, '{"a":1}'), 100)).toEqual({ ok: true, value: { a: 1 } });
  });

  it('refuses a declared Content-Length over the limit with 413 before reading', async () => {
    const res = await readBodyText(post({ 'content-length': '5000' }, 'x'), 1000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(413);
  });

  it('refuses an undeclared (streamed) body once it passes the limit', async () => {
    const res = await readBodyText(streamed(100, 1024), 10 * 1024);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(413);
    expect((await readBodyText(streamed(3, 1024), 10 * 1024)).ok).toBe(true);
  });

  it('treats an empty or malformed JSON body as 400', async () => {
    for (const body of ['', 'not json{']) {
      const res = await readJsonBody(post({}, body), 100);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.response.status).toBe(400);
    }
  });
});
