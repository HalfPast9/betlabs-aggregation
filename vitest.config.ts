import { config as loadDotenv } from "dotenv";
import { defineConfig } from "vitest/config";

// Deliberately .env.test, not .env — tests must never point at the same
// database as `npm run dev`. resetDb() never truncates staff_user (so the
// bootstrap admin survives across test files within a run), which used to
// mean a stray `npm test` against the dev DB silently replaced your local
// login with a test one. A dedicated test database makes that impossible.
const testEnv = loadDotenv({ path: ".env.test" }).parsed ?? {};

export default defineConfig({
  test: {
    env: testEnv,
    // Integration tests share one Postgres database across test files and
    // reset tables between tests; run files serially to avoid cross-file
    // interference.
    fileParallelism: false,
    testTimeout: 15000,
  },
});
