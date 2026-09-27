// Groq's OpenAI-compatible chat completions, streamed. Server only: the key is passed in by the
// route handler (from process.env) and never leaves this module — errors are reduced to a status
// so neither the key nor the upstream URL/body can reach a response or a log line.
import type { ChatMessage } from "./prompt";

export const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
export const DEFAULT_MODEL = "openai/gpt-oss-20b";

export interface GroqOptions {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  /** Whole-request deadline (connect + stream). */
  timeoutMs: number;
  /** Aborted when the visitor goes away. */
  signal?: AbortSignal;
}

export type GroqResult =
  | { ok: true; stream: ReadableStream<Uint8Array> }
  | { ok: false; reason: "http" | "timeout" | "network" | "empty"; status?: number };

/** Parse an OpenAI-style SSE body into content deltas. */
export async function* sseDeltas(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const json = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown } }> };
          const content = json.choices?.[0]?.delta?.content;
          if (typeof content === "string" && content) yield content;
        } catch {
          // A malformed line: skip it.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function streamGroq(opts: GroqOptions): Promise<GroqResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), opts.timeoutMs);
  const onVisitorAbort = () => controller.abort(new Error("client"));
  opts.signal?.addEventListener("abort", onVisitorAbort, { once: true });
  const cleanup = () => {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onVisitorAbort);
  };

  const reasoning = /gpt-oss/i.test(opts.model) ? { reasoning_effort: "low", include_reasoning: false } : {};

  let res: Response;
  try {
    res = await fetch(GROQ_CHAT_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: true,
        temperature: 0.3,
        max_completion_tokens: opts.maxTokens,
        ...reasoning,
      }),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch {
    cleanup();
    return { ok: false, reason: controller.signal.aborted ? "timeout" : "network" };
  }
  if (!res.ok || !res.body) {
    cleanup();
    // Drain nothing; the upstream body may echo request details.
    res.body?.cancel().catch(() => {});
    return { ok: false, reason: "http", status: res.status };
  }

  // Wait for the first real token before committing to a streamed answer, so an empty or failed
  // generation can still fall back to an offline answer.
  const deltas = sseDeltas(res.body);
  let first: IteratorResult<string>;
  try {
    first = await deltas.next();
  } catch {
    cleanup();
    return { ok: false, reason: controller.signal.aborted ? "timeout" : "network" };
  }
  if (first.done) {
    cleanup();
    return { ok: false, reason: "empty" };
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(encoder.encode(first.value));
    },
    async pull(ctrl) {
      try {
        const next = await deltas.next();
        if (next.done) {
          cleanup();
          ctrl.close();
        } else {
          ctrl.enqueue(encoder.encode(next.value));
        }
      } catch {
        // Deadline or network drop mid-answer: end what we have.
        cleanup();
        ctrl.enqueue(encoder.encode("…"));
        ctrl.close();
      }
    },
    cancel() {
      cleanup();
      controller.abort(new Error("client"));
    },
  });
  return { ok: true, stream };
}
