import { rmSync } from "node:fs";

// Uploaded test lectures never outlive a run (the DB is reset on the next server start).
export default function globalTeardown() {
  rmSync("data/e2e-uploads", { recursive: true, force: true });
}
