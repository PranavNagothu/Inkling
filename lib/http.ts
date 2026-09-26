// Small request guards shared by route handlers.

/**
 * Browsers send Origin on POST (fetch, forms and sendBeacon alike); refuse cross-site writes (the
 * app has no auth to lean on, so this blocks a malicious page from posting to a local server).
 * Non-browser clients (curl, Playwright's request fixture) send no Origin and are allowed.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

/**
 * Wraps a mutating route handler so a cross-site request gets 403 before the handler runs. Every
 * POST/PUT/PATCH/DELETE handler is exported through this, so a new route can't forget the check:
 *   export const POST = sameOriginOnly(async (request, ctx: RouteContext<"/api/x">) => { … });
 */
export function sameOriginOnly<Rest extends unknown[]>(
  handler: (request: Request, ...rest: Rest) => Promise<Response>,
): (request: Request, ...rest: Rest) => Promise<Response> {
  return async (request, ...rest) => {
    if (!isSameOrigin(request)) {
      return Response.json({ error: "Cross-site requests are not allowed." }, { status: 403 });
    }
    return handler(request, ...rest);
  };
}

export type BodyResult<T> = { ok: true; value: T } | { ok: false; response: Response };

const tooLarge = (maxBytes: number): BodyResult<never> => ({
  ok: false,
  response: Response.json({ error: `Request body is too large (max ${maxBytes} bytes).` }, { status: 413 }),
});

/**
 * Reads the body as UTF-8 text, refusing (413) anything over `maxBytes` — from Content-Length when
 * the client declares it, otherwise while streaming, so an oversized body is never buffered whole.
 * (Route handlers have no body-size limit of their own in Next 16.)
 */
export async function readBodyText(request: Request, maxBytes: number): Promise<BodyResult<string>> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) return tooLarge(maxBytes);
  if (!request.body) return { ok: true, value: "" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return tooLarge(maxBytes);
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, response: Response.json({ error: "Could not read the request body." }, { status: 400 }) };
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { ok: true, value: new TextDecoder().decode(bytes) };
}

/** readBodyText + JSON.parse; an empty or malformed body is a 400 "invalid JSON". */
export async function readJsonBody(request: Request, maxBytes: number): Promise<BodyResult<unknown>> {
  const text = await readBodyText(request, maxBytes);
  if (!text.ok) return text;
  try {
    return { ok: true, value: JSON.parse(text.value) as unknown };
  } catch {
    return { ok: false, response: Response.json({ error: "invalid JSON" }, { status: 400 }) };
  }
}
