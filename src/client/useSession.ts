import { useCallback, useEffect, useRef, useState } from "react";
import { ServerMessageSchema } from "../shared/protocol";
import type { ClientMessage } from "../shared/protocol";
import type { Advisory, ConstraintKind, Resolution, WorldState } from "../shared/types";

export interface SessionActions {
  startS1: () => void;
  setSpeed: (speed: 1 | 4 | 8) => void;
  approve: (id: string) => void;
  override: (id: string, reason: string, constraint: { kind: ConstraintKind; target: string; reason: string }) => void;
  dismiss: (id: string) => void;
  why: (id: string) => void;
}

export interface Session {
  connected: boolean;
  world: WorldState | null;
  agentStatus: string;
  advisory: Advisory | null;
  whyText: string | null;
  resolution: Resolution | null;
  actions: SessionActions;
}

/** WebSocket client for the MarshalSession Durable Object. Validates every inbound frame. */
export function useSession(): Session {
  const [connected, setConnected] = useState(false);
  const [world, setWorld] = useState<WorldState | null>(null);
  const [agentStatus, setAgentStatus] = useState("connecting to Marshal");
  const [advisory, setAdvisory] = useState<Advisory | null>(null);
  const [whyText, setWhyText] = useState<string | null>(null);
  const [resolution, setResolution] = useState<Resolution | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const outbox = useRef<ClientMessage[]>([]);

  const send = useCallback((message: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    else outbox.current.push(message);
  }, []);

  useEffect(() => {
    let stopped = false;
    let ws: WebSocket;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        for (const m of outbox.current) ws.send(JSON.stringify(m));
        outbox.current = [];
      };
      ws.onmessage = (event) => {
        let raw: unknown;
        try {
          raw = JSON.parse(typeof event.data === "string" ? event.data : "");
        } catch {
          return;
        }
        const parsed = ServerMessageSchema.safeParse(raw);
        if (!parsed.success) return;
        const msg = parsed.data;
        if (msg.type === "tick") setWorld(msg.state);
        else if (msg.type === "agent_status") setAgentStatus(msg.text);
        else if (msg.type === "advisory") {
          setAdvisory(msg.advisory);
          setWhyText(null);
        } else if (msg.type === "why") setWhyText(msg.text);
        else if (msg.type === "resolution") setResolution(msg.resolution);
      };
      ws.onclose = () => {
        setConnected(false);
        if (!stopped) setTimeout(connect, 800);
      };
    };

    connect();
    return () => {
      stopped = true;
      wsRef.current?.close();
    };
  }, []);

  const actions: SessionActions = {
    startS1: () => {
      setAdvisory(null);
      setWhyText(null);
      setResolution(null);
      send({ type: "control", action: "start_scenario", scenario: "S1" });
    },
    setSpeed: (speed) => send({ type: "control", action: "set_speed", speed }),
    approve: (id) => send({ type: "control", action: "approve", advisory_id: id }),
    override: (id, reason, constraint) =>
      send({ type: "control", action: "override", advisory_id: id, reason, constraint }),
    dismiss: (id) => send({ type: "control", action: "dismiss", advisory_id: id }),
    why: (id) => send({ type: "control", action: "why", advisory_id: id }),
  };

  return { connected, world, agentStatus, advisory, whyText, resolution, actions };
}
