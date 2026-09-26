import { getProgress } from "@/lib/gaps";
import { sameOriginOnly } from "@/lib/http";

/** Every gap thread of the local student, per lecture: status, first seen, resolved when/how. */
export const GET = sameOriginOnly(async () => Response.json(await getProgress()));
