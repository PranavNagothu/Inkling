import lecture from "@/public/demo/lecture.json";

/**
 * The bundled demo lecture. It is seeded into the lectures table on startup (lib/db.ts) and then
 * behaves like any uploaded lecture; its media is served by /api/lectures/[id]/media.
 */
export const DEMO_LECTURE = {
  lectureId: lecture.lectureId,
  courseId: lecture.courseId,
  title: lecture.title,
  durationMs: lecture.durationMs,
} as const;

/** Demo media, relative to the project root. */
export const DEMO_MEDIA_PATH = "public/demo/lecture.wav";
