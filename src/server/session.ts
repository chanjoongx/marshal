/**
 * MarshalSession: the Durable Object that holds one session's world (Sim) and agent, drives a
 * ticking alarm at the current speed, and speaks the WebSocket protocol (src/shared/protocol.ts).
 * Each alarm advances `speed` sim-seconds in 1-second sub-steps, runs the agent, and broadcasts
 * tick/advisory/agent_status/resolution. Inbound control messages are validated with
 * ClientMessageSchema. Provider is chosen with getProvider(env) so MOCK=1 runs fully offline.
 */
import { DurableObject } from "cloudflare:workers";
import { ClientMessageSchema } from "../shared/protocol";
import type { ClientMessage, ServerMessage } from "../shared/protocol";
import type { WorldState } from "../shared/types";
import { getProvider, type InferenceEnv, type Provider } from "../inference/inference";
import { Sim } from "./sim";
import { Agent, newSessionState, type SessionState } from "./agent";

export interface Env extends InferenceEnv {
  SESSION: DurableObjectNamespace<MarshalSession>;
  ASSETS: Fetcher;
}

const TICK_MS = 1000; // one alarm per real second; each tick advances `speed` sim-seconds

export class MarshalSession extends DurableObject<Env> {
  private sim = new Sim();
  private provider: Provider;
  private agent: Agent;
  private session: SessionState = newSessionState();
  private sockets = new Set<WebSocket>();
  private lastStatus: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.provider = getProvider(env);
    this.agent = new Agent(this.provider);
    this.lastStatus = this.statusNow();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.sockets.add(server);
    server.addEventListener("message", (event) => this.onMessage(server, event.data));
    server.addEventListener("close", () => this.sockets.delete(server));
    server.addEventListener("error", () => this.sockets.delete(server));

    this.sendTo(server, { type: "tick", state: this.world() });
    this.sendTo(server, { type: "agent_status", text: this.lastStatus });
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm(): Promise<void> {
    await this.serialize(() => this.doTick());
    if (this.sim.running) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  /* --------------------------------- ticking --------------------------------- */

  private async doTick(): Promise<void> {
    if (!this.sim.running) return;
    try {
      this.sim.advance(this.sim.speed); // `speed` sim-seconds in 1-second sub-steps
      const result = await this.agent.tick(this.sim, this.session);
      this.lastStatus = result.status;
      this.broadcast({ type: "tick", state: this.world() });
      this.broadcast({ type: "agent_status", text: result.status });
      if (result.advisory) this.broadcast({ type: "advisory", advisory: result.advisory });
      const resolution = this.agent.maybeResolve(this.sim, this.session);
      if (resolution) this.broadcast({ type: "resolution", resolution });
    } catch (err) {
      // A transient inference failure must not stop the sim (docs/CRUSOE_NOTES.md).
      this.broadcast({ type: "agent_status", text: "reasoning temporarily unavailable, retrying" });
      this.broadcast({ type: "tick", state: this.world() });
      void err;
    }
  }

  /* ----------------------------- control handling ---------------------------- */

  private onMessage(ws: WebSocket, data: string | ArrayBuffer): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
    } catch {
      this.sendTo(ws, { type: "error", message: "invalid JSON" });
      return;
    }
    const result = ClientMessageSchema.safeParse(parsed);
    if (!result.success) {
      this.sendTo(ws, { type: "error", message: "invalid control message" });
      return;
    }
    void this.serialize(() => this.handleControl(result.data)).catch((err) =>
      this.sendTo(ws, { type: "error", message: `control failed: ${String(err)}` }),
    );
  }

  private async handleControl(msg: ClientMessage): Promise<void> {
    switch (msg.action) {
      case "start_scenario": {
        this.sim.start(msg.scenario);
        this.agent.reset();
        this.session = newSessionState();
        this.lastStatus = this.statusNow();
        this.broadcast({ type: "tick", state: this.world() });
        this.broadcast({ type: "agent_status", text: this.lastStatus });
        if (this.sim.running) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
        break;
      }
      case "set_speed": {
        this.sim.setSpeed(msg.speed);
        this.broadcast({ type: "tick", state: this.world() });
        break;
      }
      case "approve": {
        if (this.agent.handleApprove(this.sim, this.session, msg.advisory_id)) {
          this.broadcast({ type: "tick", state: this.world() });
          const resolution = this.agent.maybeResolve(this.sim, this.session);
          if (resolution) this.broadcast({ type: "resolution", resolution });
        }
        break;
      }
      case "override": {
        const advisory = await this.agent.handleOverride(
          this.sim,
          this.session,
          msg.advisory_id,
          msg.reason,
          msg.constraint,
        );
        this.broadcast({ type: "tick", state: this.world() });
        if (advisory) this.broadcast({ type: "advisory", advisory });
        break;
      }
      case "dismiss": {
        if (this.agent.handleDismiss(this.sim, this.session, msg.advisory_id)) {
          this.broadcast({ type: "tick", state: this.world() });
        }
        break;
      }
      case "why": {
        const text = await this.agent.why(this.sim, this.session, msg.advisory_id);
        this.broadcast({ type: "why", advisory_id: msg.advisory_id, text });
        break;
      }
      case "reset": {
        this.sim.reset();
        this.agent.reset();
        this.session = newSessionState();
        this.lastStatus = this.statusNow();
        await this.ctx.storage.deleteAlarm();
        this.broadcast({ type: "tick", state: this.world() });
        this.broadcast({ type: "agent_status", text: this.lastStatus });
        break;
      }
    }
  }

  /* --------------------------------- helpers --------------------------------- */

  private world(): WorldState {
    const states = this.sim.getRackStates();
    return {
      scenario: this.sim.scenario,
      sim_time_s: this.sim.simTime,
      speed: this.sim.speed,
      running: this.sim.running,
      cluster_summary: this.sim.clusterSummary(states),
      racks: states,
      queue: this.sim.getQueue(),
      constraints: this.session.constraints,
      effects: this.sim.effects,
      advisories_recent: this.session.records.slice(-6),
    };
  }

  private statusNow(): string {
    const states = this.sim.getRackStates();
    return `Marshal watching ${states.length} racks, ${this.sim.clusterNote(states)}`;
  }

  private broadcast(message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const ws of this.sockets) {
      try {
        ws.send(data);
      } catch {
        this.sockets.delete(ws);
      }
    }
  }

  private sendTo(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      this.sockets.delete(ws);
    }
  }

  /** Serialize alarm ticks and control handlers so they never interleave on shared state. */
  private serialize<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
