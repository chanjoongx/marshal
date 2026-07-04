import { useEffect, useMemo, useState } from "react";
import { useSession } from "./useSession";
import { SIM } from "../shared/types";
import type { Advisory, AdvisoryRecord, RackState, Resolution, WorldState } from "../shared/types";

type ForecastPoint = { t: number; temp: number; proj: number; id: string };

const SPEEDS = [1, 4, 8] as const;

export function App() {
  const { connected, world, agentStatus, advisory, whyText, resolution, actions } = useSession();
  const [overrideOpen, setOverrideOpen] = useState(false);

  const outcome = useMemo(() => {
    if (!advisory || !world) return "pending";
    return world.advisories_recent.find((r) => r.advisory.id === advisory.id)?.outcome ?? "pending";
  }, [advisory, world]);

  const learnedLabel = useMemo(() => {
    if (!advisory?.learned_from) return null;
    const c = world?.constraints.find((x) => x.id === advisory.learned_from);
    if (!c) return "learned: operator rule applied";
    const verb =
      c.kind === "avoid_row" ? `avoids row ${c.target}` : c.kind === "pin_job" ? `pins ${c.target}` : `avoids rack ${c.target}`;
    return `learned: ${verb} (${c.reason})`;
  }, [advisory, world]);

  const speed = world?.speed ?? 1;

  // Accumulate the at-risk rack's temperature so the agent can show its live forecast: the
  // history line, the 5-minute projection, and the throttle line it is trying to stay under.
  const [history, setHistory] = useState<ForecastPoint[]>([]);
  const simTime = world?.sim_time_s ?? 0;
  useEffect(() => {
    if (!world || world.racks.length === 0) return;
    const focus = [...world.racks].sort((a, b) => b.projected_temp_5m - a.projected_temp_5m)[0];
    setHistory((h) => {
      const last = h[h.length - 1];
      if (last && last.t === simTime) return h; // one point per sim-second
      const base = last && simTime < last.t ? [] : h; // reset when the scenario restarts
      return [...base, { t: simTime, temp: focus.gpu_temp_c, proj: focus.projected_temp_5m, id: focus.id }].slice(-90);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simTime]);
  const showForecast = history.length >= 3 && history[history.length - 1].proj >= 72;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark">MARSHAL</span>
          <span className="tagline">predicts rack thermal throttling before it happens</span>
        </div>
        <div className="topbar-right">
          <span className={`link ${connected ? "up" : "down"}`}>{connected ? "live" : "offline"}</span>
          <span className="badge" data-testid="simulated-badge">
            SIMULATED TELEMETRY
          </span>
        </div>
      </header>

      <div className="controls">
        <button className="primary" data-testid="start-s1" onClick={actions.startS1}>
          Start S1 - batch surge
        </button>
        <div className="speeds">
          <span className="lbl">speed</span>
          {SPEEDS.map((s) => (
            <button
              key={s}
              data-testid={`speed-${s}x`}
              className={speed === s ? "on" : ""}
              onClick={() => actions.setSpeed(s)}
            >
              {s}x
            </button>
          ))}
        </div>
        <div className="clock">
          <span className="lbl">sim</span> t={world?.sim_time_s ?? 0}s
          {world?.scenario && world.scenario !== "idle" ? <span className="scn"> · {world.scenario}</span> : null}
        </div>
      </div>

      <div className="agent-status" data-testid="agent-status">
        <span className="pulse" aria-hidden />
        {agentStatus}
      </div>

      <main className="layout">
        <section className="feed" aria-label="agent feed">
          <div className="feed-head">AGENT FEED</div>

          {advisory ? (
            <AdvisoryCard
              advisory={advisory}
              outcome={outcome}
              learnedLabel={learnedLabel}
              onApprove={() => actions.approve(advisory.id)}
              onOverride={() => setOverrideOpen((v) => !v)}
              onWhy={() => actions.why(advisory.id)}
            />
          ) : (
            <div className="feed-empty">Marshal is watching {world?.racks.length ?? 24} racks. No action required.</div>
          )}

          {showForecast ? <ForecastChart history={history} throttle={SIM.THROTTLE_TEMP_C} /> : null}

          {whyText ? (
            <div className="why">
              <div className="why-label">Why</div>
              <div className="why-body" data-testid="why-text">
                {whyText}
              </div>
            </div>
          ) : null}

          {overrideOpen && advisory ? (
            <OverridePanel
              onSubmit={(text) => {
                actions.override(advisory.id, text);
                setOverrideOpen(false);
              }}
              onCancel={() => setOverrideOpen(false)}
            />
          ) : null}

          {resolution ? <ResolutionCard resolution={resolution} /> : null}

          <FeedLog records={world?.advisories_recent ?? []} activeId={advisory?.id} />
        </section>

        <aside className="context" aria-label="rack view">
          <Heatmap world={world} />
        </aside>
      </main>

      <footer className="footer">
        reasoning: NVIDIA-Nemotron-3-Ultra-550B via Crusoe Managed Inference
      </footer>
    </div>
  );
}

function AdvisoryCard(props: {
  advisory: Advisory;
  outcome: string;
  learnedLabel: string | null;
  onApprove: () => void;
  onOverride: () => void;
  onWhy: () => void;
}) {
  const { advisory, outcome, learnedLabel } = props;
  const pending = outcome === "pending";
  return (
    <div className={`card sev-${advisory.severity} ${pending ? "" : "resolved"}`} data-testid="advisory-card" data-advisory-id={advisory.id}>
      <div className="card-top">
        <span className={`sev-chip sev-${advisory.severity}`}>{advisory.severity}</span>
        <span className="area">{advisory.area}</span>
        {advisory.origin === "auto" ? (
          <span className="auto-chip">rule-based fallback</span>
        ) : advisory.origin === "mock" ? (
          <span className="mock-chip" data-testid="advisory-origin">
            simulated model
          </span>
        ) : (
          <span className="model-chip" data-testid="advisory-origin">
            Nemotron{advisory.latency_ms ? ` · ${(advisory.latency_ms / 1000).toFixed(1)}s` : ""}
          </span>
        )}
        {!pending ? <span className="outcome-chip">{outcome}</span> : null}
      </div>
      <div className="headline" data-testid="advisory-headline">
        {advisory.headline}
      </div>
      <div className="rationale">{advisory.rationale}</div>
      <div className="action" data-testid="advisory-action">
        {advisory.action.one_line}
      </div>
      {learnedLabel ? (
        <div className="learned" data-testid="advisory-learned">
          {learnedLabel}
        </div>
      ) : null}
      {advisory.rule_pick ? (
        <div className="rule-pick" data-testid="advisory-rule-pick">
          <span className="rp-label">a headroom-only rule would</span>
          <span className="rp-body">
            {advisory.rule_pick.one_line} - {advisory.rule_pick.flaw}
          </span>
        </div>
      ) : null}
      {advisory.alternatives.length > 0 ? (
        <div className="alts">
          alternatives: {advisory.alternatives.map((a) => a.one_line).join(" · ")}
        </div>
      ) : null}
      <div className="btns">
        <button className="approve" data-testid="btn-approve" disabled={!pending} onClick={props.onApprove}>
          Approve
        </button>
        <button className="override" data-testid="btn-override" disabled={!pending} onClick={props.onOverride}>
          Override
        </button>
        <button className="why" data-testid="btn-why" onClick={props.onWhy}>
          Why
        </button>
      </div>
    </div>
  );
}

function OverridePanel(props: { onSubmit: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const submit = () => {
    if (text.trim()) props.onSubmit(text.trim());
  };
  return (
    <div className="override">
      <div className="override-head">Tell Marshal what the telemetry cannot see</div>
      <label>
        <span>In plain language</span>
        <input
          data-testid="override-text"
          value={text}
          placeholder="B3 has a firmware update in 10 min"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
      </label>
      <div className="override-hint">Marshal reads this and reconciles it. Exclude a rack, avoid a row, or pin a job.</div>
      <div className="override-btns">
        <button className="approve" data-testid="override-submit" onClick={submit}>
          Submit override
        </button>
        <button className="ghost" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ResolutionCard(props: { resolution: Resolution }) {
  const { resolution } = props;
  return (
    <div className="resolution">
      <div className="resolution-head">Resolved · {resolution.area}</div>
      <div className="resolution-summary">{resolution.summary}</div>
      <ol className="timeline">
        {resolution.timeline.map((e, i) => (
          <li key={i}>
            <span className="t">t={Math.round(e.ts)}s</span> {e.label}
          </li>
        ))}
      </ol>
    </div>
  );
}

function FeedLog(props: { records: AdvisoryRecord[]; activeId?: string }) {
  const past = props.records.filter((r) => r.advisory.id !== props.activeId).slice(-5).reverse();
  if (past.length === 0) return null;
  return (
    <div className="log">
      <div className="log-head">history</div>
      {past.map((r) => (
        <div className={`log-entry outcome-${r.outcome}`} key={r.advisory.id}>
          <span className="log-outcome">{r.outcome}</span>
          <span className="log-line">{r.advisory.action.one_line}</span>
        </div>
      ))}
    </div>
  );
}

function Heatmap(props: { world: WorldState | null }) {
  const racks = props.world?.racks ?? [];
  const rowB = racks.filter((r) => r.row === "B").sort((a, b) => a.position - b.position);
  const rowA = racks.filter((r) => r.row === "A").sort((a, b) => a.position - b.position);
  const s = props.world?.cluster_summary;
  return (
    <div className="heatmap">
      <div className="heat-head">
        RACK VIEW <span className="ctx">context</span>
      </div>
      {s ? (
        <div className="cluster">
          {s.racks_total} racks · watch {s.racks_watch} · warn {s.racks_warn} · critical {s.racks_critical}
        </div>
      ) : null}
      <div className="aisle-label">Aisle B - GPU compute</div>
      <div className="grid grid-b">
        {rowB.map((r) => (
          <RackCell key={r.id} rack={r} />
        ))}
      </div>
      <div className="aisle-label">Aisle A - mixed</div>
      <div className="grid grid-a">
        {rowA.map((r) => (
          <RackCell key={r.id} rack={r} />
        ))}
      </div>
      <div className="legend">
        <span className="band-nominal">nominal</span>
        <span className="band-watch">watch</span>
        <span className="band-warn">warn</span>
        <span className="band-critical">critical</span>
      </div>
    </div>
  );
}

function RackCell(props: { rack: RackState }) {
  const r = props.rack;
  const proj = r.projected_temp_5m;
  const willThrottle = 84 - proj <= 15 && r.band === "nominal";
  return (
    <div
      className={`rack band-${r.band} ${willThrottle ? "predicted" : ""}`}
      data-testid={`rack-${r.id}`}
      data-temp={r.gpu_temp_c}
      data-projected={r.projected_temp_5m}
      data-band={r.band}
      title={`${r.id}: ${r.gpu_temp_c}C now, ${proj}C projected, headroom ${r.headroom_w}W`}
    >
      <span className="rid">{r.id}</span>
      <span className="rtemp">{Math.round(r.gpu_temp_c)}&deg;</span>
      <span className="rproj">&rarr;{Math.round(proj)}&deg;</span>
    </div>
  );
}

/**
 * The agent's live temperature forecast for the at-risk rack: the measured history, the 5-minute
 * projection, and the throttle line it is steering under. This is Marshal reasoning out loud, not
 * a monitoring chart: it appears only while a rack is heading toward throttle, and the projection
 * bends away the moment an action is approved.
 */
function ForecastChart(props: { history: ForecastPoint[]; throttle: number }) {
  const { history, throttle } = props;
  const W = 344;
  const H = 132;
  const padL = 8;
  const padR = 26;
  const padT = 14;
  const padB = 18;
  const last = history[history.length - 1];
  const tMin = history[0].t;
  const tMax = last.t + SIM.PROJECTION_HORIZON_S;
  const yMin = 55;
  const yMax = 92;
  const sx = (t: number) => padL + ((W - padL - padR) * (t - tMin)) / Math.max(1, tMax - tMin);
  const sy = (v: number) => padT + (H - padT - padB) * (1 - (Math.min(yMax, Math.max(yMin, v)) - yMin) / (yMax - yMin));
  const tempPath = history.map((p, i) => `${i ? "L" : "M"}${sx(p.t).toFixed(1)},${sy(p.temp).toFixed(1)}`).join(" ");
  const nowX = sx(last.t);
  const nowY = sy(last.temp);
  const projX = sx(last.t + SIM.PROJECTION_HORIZON_S);
  const projY = sy(last.proj);
  const throttleY = sy(throttle);
  const willCross = last.proj >= throttle;
  return (
    <div className={`forecast ${willCross ? "at-risk" : "safe"}`} data-testid="forecast-chart">
      <div className="forecast-head">
        <span className="fc-title">MARSHAL FORECAST · {last.id}</span>
        <span className="fc-proj">
          {willCross ? "projected to cross " : "projected "}
          {Math.round(last.proj)}&deg;C in 5 min
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`temperature forecast for ${last.id}`}>
        <line className="throttle-line" x1={padL} y1={throttleY} x2={W - padR} y2={throttleY} />
        <text className="axis-label throttle-text" x={padL} y={throttleY - 5}>
          {throttle}&deg; throttle line
        </text>
        <path className="temp-line" d={tempPath} fill="none" />
        <line className={`proj-line ${willCross ? "crossing" : "safe"}`} x1={nowX} y1={nowY} x2={projX} y2={projY} />
        <circle className="now-dot" cx={nowX} cy={nowY} r={3} />
        <circle className={`proj-dot ${willCross ? "crossing" : "safe"}`} cx={projX} cy={projY} r={3} />
        <text className="axis-label proj-text" x={projX - 4} y={projY - 6} textAnchor="end">
          {Math.round(last.proj)}&deg;
        </text>
      </svg>
    </div>
  );
}
