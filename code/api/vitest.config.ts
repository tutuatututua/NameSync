import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./test/globalSetup.ts"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Integration tests share one DB + app; run files sequentially to avoid clashes.
    fileParallelism: false,
    pool: "forks",
  },
});
