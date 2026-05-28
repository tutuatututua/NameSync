import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  maxFailures: 1,
  reporter: [["line"], ["json", { outputFile: "test-results.json" }]],
  timeout: 60000, // Increase global timeout to 60s
  use: {
    baseURL: "http://localhost:3000",
    trace: "on",
    headless: true,
    browserName: "chromium",
    launchOptions: {
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    },
    viewport: { width: 1280, height: 720 },
    actionTimeout: 30000,
    navigationTimeout: 30000,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      Accept: "*/*",
      Origin: "http://localhost:3000",
    },
  },
});
