/**
 * Marshal WebSocket protocol. The server <-> client message contract, zod-validated
 * on both ends. The server pushes ticks, advisories, agent status, resolutions, and
 * Why answers; the client sends control actions. Semantics live in docs/AGENT_SPEC.md
 * and PLAN.md. Parse every inbound message with the matching schema before acting.
 */
import { z } from "zod";
import {
  WorldStateSchema,
  AdvisorySchema,
  ResolutionSchema,
  ScenarioIdSchema,
  SimSpeedSchema,
  ConstraintKindSchema,
} from "./types";

/* ------------------------------ Server -> client ------------------------------ */

export const ServerTickSchema = z.object({
  type: z.literal("tick"),
  state: WorldStateSchema,
});

export const ServerAdvisorySchema = z.object({
  type: z.literal("advisory"),
  advisory: AdvisorySchema,
});

export const ServerAgentStatusSchema = z.object({
  type: z.literal("agent_status"),
  text: z.string(), // terse ops line, e.g. "Marshal watching 24 racks, cluster nominal"
});

export const ServerResolutionSchema = z.object({
  type: z.literal("resolution"),
  resolution: ResolutionSchema,
});

export const ServerWhySchema = z.object({
  type: z.literal("why"),
  advisory_id: z.string(),
  text: z.string(), // <= 3 sentences citing snapshot numbers, no new recommendation
});

export const ServerErrorSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
});

export const ServerMessageSchema = z.discriminatedUnion("type", [
  ServerTickSchema,
  ServerAdvisorySchema,
  ServerAgentStatusSchema,
  ServerResolutionSchema,
  ServerWhySchema,
  ServerErrorSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/* ------------------------------ Client -> server ------------------------------ */

export const ControlStartSchema = z.object({
  type: z.literal("control"),
  action: z.literal("start_scenario"),
  scenario: ScenarioIdSchema,
});

export const ControlSetSpeedSchema = z.object({
  type: z.literal("control"),
  action: z.literal("set_speed"),
  speed: SimSpeedSchema,
});

export const ControlApproveSchema = z.object({
  type: z.literal("control"),
  action: z.literal("approve"),
  advisory_id: z.string(),
});

/**
 * Override adds a structured constraint (server assigns id/ts/source) that is injected
 * into every future snapshot. `reason` is stored on the advisory record; `constraint`
 * is the machine-readable rule the agent must reconcile going forward.
 */
export const ControlOverrideSchema = z.object({
  type: z.literal("control"),
  action: z.literal("override"),
  advisory_id: z.string(),
  reason: z.string(),
  constraint: z
    .object({
      kind: ConstraintKindSchema,
      target: z.string(),
      reason: z.string(),
    })
    .optional(),
});

export const ControlDismissSchema = z.object({
  type: z.literal("control"),
  action: z.literal("dismiss"),
  advisory_id: z.string(),
});

export const ControlWhySchema = z.object({
  type: z.literal("control"),
  action: z.literal("why"),
  advisory_id: z.string(),
});

export const ControlResetSchema = z.object({
  type: z.literal("control"),
  action: z.literal("reset"),
});

export const ClientMessageSchema = z.discriminatedUnion("action", [
  ControlStartSchema,
  ControlSetSpeedSchema,
  ControlApproveSchema,
  ControlOverrideSchema,
  ControlDismissSchema,
  ControlWhySchema,
  ControlResetSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
