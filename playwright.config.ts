import { defineConfig } from "@playwright/test";

// Smoke test config. Launches the app offline (MockProvider) and points Playwright at it.
// If Cursor's dev server uses a port other than 5173, align both URLs below.
export default defineConfig({
  testDir: "tests",
  timeout: 60_000,
  fullyParallel: false,
  use: { baseURL: "http://localhost:5173", trace: "on-first-retry" },
  webServer: {
    command: "MOCK=1 npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
