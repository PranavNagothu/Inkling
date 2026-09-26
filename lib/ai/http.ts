import "server-only";

// Route-handler glue for the AI service: failures become JSON errors (429 with Retry-After).
import type { Fail } from "./service";

export function failResponse(fail: Fail): Response {
  const headers: Record<string, string> = {};
  if (fail.status === 429 && fail.retryAfterMs) headers["retry-after"] = String(Math.ceil(fail.retryAfterMs / 1000));
  return Response.json({ error: fail.error }, { status: fail.status, headers });
}
