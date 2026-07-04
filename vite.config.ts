import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

// Client (React) + Worker (MarshalSession DO) served by one dev server on :5173.
// The assets binding + SPA routing are added programmatically so wrangler.jsonc stays as the
// authored contract. /api/* runs the Worker first (the WebSocket upgrade lives at /api/ws);
// everything else is served as static client assets.
export default defineConfig({
  plugins: [
    react(),
    cloudflare({
      config: {
        assets: {
          binding: "ASSETS",
          not_found_handling: "single-page-application",
          run_worker_first: ["/api/*"],
        },
      },
    }),
  ],
  server: { port: 5173 },
});
