import { defineConfig } from "vitest/config";

// Unit tests are pure (sim + agent + decision helpers) and run in plain Node, kept separate
// from the Cloudflare Vite build config. The Playwright smoke test in tests/ is excluded here;
// it runs via `npm run test:smoke`.
export default defineConfig({
  test: {
    include: ["src/server/**/*.test.ts"],
    environment: "node",
  },
});
