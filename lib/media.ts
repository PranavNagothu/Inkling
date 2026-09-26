// Client-safe lecture media helpers.

/** Public URL of a lecture's media (the Range-capable route handler; also used for the demo). */
export function lectureMediaUrl(id: string): string {
  return `/api/lectures/${encodeURIComponent(id)}/media`;
}
