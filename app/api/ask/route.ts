// POST /api/ask — the "Ask Inkling" assistant.
//
// Answers questions about Inkling, grounded in lib/knowledge.ts, with Groq (streamed plain text).
// Without a key, when disabled, over quota, or when the model call fails, it answers from the
// same knowledge base with a deterministic keyword matcher instead ("offline answer").
//
// Guards: same-origin only, POST only (other methods get 405 from Next), JSON body ≤ 2 KB,
// question ≤ 500 chars, ≤ 6 turns of history, per-IP limits (10/min and 60/day for model calls,
// plus a coarse 30/min on the endpoint itself), a global daily cap on model calls, a 10 s
// deadline, and generic error messages. The key is read here, server side, and never logged.
//
// Env: GROQ_API_KEY, LANDING_AI_MODEL (default openai/gpt-oss-20b), LANDING_AI_DAILY_CAP
// (default 500), LANDING_AI_DISABLED=1 (always answer offline).
import { offlineAnswer } from "@/lib/landing/ask/faq";
import { DEFAULT_MODEL, streamGroq } from "@/lib/landing/ask/groq";
import { clientIp, isSameOrigin } from "@/lib/landing/ask/origin";
import { buildMessages } from "@/lib/landing/ask/prompt";
import { RateLimiter, envInt } from "@/lib/landing/ask/rateLimit";
import { ASK_LIMITS, parseAskBody } from "@/lib/landing/ask/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TOKENS = 350;
const TIMEOUT_MS = 10_000;

/** Model calls: the cost guard. Over it, answers come from the offline matcher. */
const modelLimiter = new RateLimiter({
  perMinute: 10,
  perDay: 60,
  globalPerDay: envInt(process.env.LANDING_AI_DAILY_CAP, 500),
});
/** Every request (offline answers included): the abuse guard. Over it, 429. */
const requestLimiter = new RateLimiter({ perMinute: 30, perDay: 400, globalPerDay: 100_000 });

const BASE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function error(status: number, message: string, extra?: Record<string, string>) {
  return Response.json({ error: message }, { status, headers: { ...BASE_HEADERS, ...extra } });
}

function answer(body: string | ReadableStream<Uint8Array>, source: "ai" | "offline") {
  return new Response(body, {
    status: 200,
    headers: { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8", "x-answer-source": source },
  });
}

/** Read the body with a hard byte cap (Content-Length can be absent or wrong). */
async function readBody(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

export async function POST(req: Request): Promise<Response> {
  if (!isSameOrigin(req.headers)) return error(403, "Forbidden.");

  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) return error(415, "Send JSON.");

  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > ASK_LIMITS.maxBodyBytes) return error(413, "Request too large.");

  const ip = clientIp(req.headers);
  const gate = requestLimiter.take(ip);
  if (!gate.ok) return error(429, "Too many questions. Please wait a minute and try again.", { "retry-after": "60" });

  const raw = await readBody(req, ASK_LIMITS.maxBodyBytes);
  if (raw === null) return error(413, "Request too large.");
  const parsed = parseAskBody(raw);
  if (!parsed.ok) return error(parsed.status, parsed.error);
  const { message, history } = parsed.value;

  const offline = () => answer(offlineAnswer(message).text, "offline");

  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey || process.env.LANDING_AI_DISABLED === "1") return offline();
  if (!modelLimiter.take(ip).ok) return offline();

  const result = await streamGroq({
    apiKey,
    model: process.env.LANDING_AI_MODEL?.trim() || DEFAULT_MODEL,
    messages: buildMessages(message, history),
    maxTokens: MAX_TOKENS,
    timeoutMs: TIMEOUT_MS,
    signal: req.signal,
  });
  if (!result.ok) {
    // Status/reason only: never the key, URL or upstream body.
    console.warn(`[ask] model call failed (${result.reason}${result.status ? ` ${result.status}` : ""}); answered offline`);
    return offline();
  }
  return answer(result.stream, "ai");
}
