// Deletes the offline-demo e2e database (SQLite file + WAL files, or the PGlite directory when
// INKLING_TEST_PG=1) and its uploads before the production demo server is seeded and started.
import { rmSync } from "node:fs";
for (const suffix of ["", "-wal", "-shm"]) rmSync(`data/e2e-demo.db${suffix}`, { force: true });
rmSync("data/e2e-demo-pg", { recursive: true, force: true });
rmSync("data/e2e-demo-uploads", { recursive: true, force: true });
rmSync("data/e2e-demo-tts", { recursive: true, force: true });
