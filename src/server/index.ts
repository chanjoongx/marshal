/**
 * Worker entry for Marshal. Routes the WebSocket upgrade at /api/ws to the single
 * MarshalSession Durable Object and serves the React client (static assets) for everything
 * else. The DO holds the sim + agent; this file is just routing.
 */
import { MarshalSession } from "./session";
import type { Env } from "./session";

export { MarshalSession };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      // Isolate each client in its own Durable Object so concurrent viewers (for example two
      // judges) never share or reset one another's world. The client passes a stable per-tab id.
      const s = url.searchParams.get("s");
      const id = env.SESSION.idFromName(s ? `marshal-${s}` : "marshal-default");
      return env.SESSION.get(id).fetch(request);
    }

    if (url.pathname.startsWith("/api/")) {
      return new Response("not found", { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
