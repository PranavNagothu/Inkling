// Deletes the e2e database (SQLite file + WAL files, or the PGlite directory when INKLING_TEST_PG=1) and
// uploaded test lectures before the test server starts.
import { rmSync } from "node:fs";
for (const suffix of ["", "-wal", "-shm"]) rmSync(`data/e2e.db${suffix}`, { force: true });
rmSync("data/e2e-pg", { recursive: true, force: true });
rmSync("data/e2e-uploads", { recursive: true, force: true });
rmSync("data/e2e-tts", { recursive: true, force: true });
