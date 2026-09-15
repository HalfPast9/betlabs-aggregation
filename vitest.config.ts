import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests share one local Postgres instance and reset tables
    // between tests; run files serially to avoid cross-file interference.
    fileParallelism: false,
    testTimeout: 15000,
  },
});
