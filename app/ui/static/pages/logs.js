// Logs & traces: the audit JSONL as a timeline grouped by agent
// session, with per-event-type detail and the hook transport-error tail.
import { html, api, state, update, showError } from "/app.js";

const EVENT_TYPES = ["", "prompt_serve", "retrieve", "skill_read", "gate_denial", "plan_serve",
  "plan_manifest_extend", "skill_added", "skill_edited", "skill_configured", "reindex", "ingest", "skills_sync"];

export function LogsPage() {
  const s = state.logs;
  if (s.events === null) load();
  const sessions = groupBySession(s.events || []);
  return html`
    <div class="toolbar">
      <select value=${s.eventType} onChange=${(e) => { state.logs.eventType = e.target.value; load(); }}>
        ${EVENT_TYPES.map((t) => html`<option value=${t}>${t || "all event types"}</option>`)}
      </select>
      <input placeholder="agent session id…" value=${s.session}
        onChange=${(e) => { state.logs.session = e.target.value.trim(); load(); }} />
      <button onclick=${load}>refresh</button>
      <span class="muted">${(s.events || []).length} of ${s.total} events (auth_bypass hidden)</span>
    </div>
    ${s.events === false && html`<p class="muted">loading…</p>`}
    ${sessions.map(SessionGroup)}
    ${HookErrors()}
  `;
}

function load() {
  state.logs.events = false;
  const params = new URLSearchParams({ limit: "300" });
  if (state.logs.eventType) params.set("event_type", state.logs.eventType);
  if (state.logs.session) params.set("session", state.logs.session);
  api(`/api/local/audit?${params}`)
    .then((body) => update((st) => { st.logs.events = body.events; st.logs.total = body.total; }))
    .catch((err) => { showError(err); update((st) => { st.logs.events = []; }); });
  update();
}

function groupBySession(events) {
  const groups = new Map();
  for (const event of events) {
    const key = event.agent_session_id || "(no session)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  return [...groups.entries()];
}

function SessionGroup([sessionId, events]) {
  const newest = events[0]?.ts || "";
  return html`
    <details class="session" open=${events.length < 30}>
      <summary>
        <code>${sessionId.slice(0, 8)}</code>
        <span class="muted">${events.length} events · latest ${fmtTs(newest)}</span>
        ${events.some((e) => e.event_type === "gate_denial") && html`<span class="tag warn">denials</span>`}
      </summary>
      <table class="events">
        <tbody>${events.map(EventRow)}</tbody>
      </table>
    </details>`;
}

function EventRow(event) {
  const key = `${event.ts}:${event.tool_call_id}`;
  const expanded = state.logs.expanded[key];
  return html`
    <tr class="event ${event.event_type}" onclick=${() => update((st) => { st.logs.expanded[key] = !expanded; })}>
      <td class="ts">${fmtTs(event.ts)}</td>
      <td><span class="tag ${event.event_type === "gate_denial" ? "warn" : ""}">${event.event_type}</span></td>
      <td>${summary(event)}</td>
    </tr>
    ${expanded && html`<tr><td colspan="3"><pre>${JSON.stringify(event.payload, null, 2)}</pre></td></tr>`}`;
}

// One human line per event type; the expanded row shows the raw payload.
function summary(event) {
  const p = event.payload || {};
  switch (event.event_type) {
    case "retrieve": return `"${(p.intent || "").slice(0, 90)}" → ${(p.returned || []).length} results`;
    case "skill_read": return p.id;
    case "gate_denial": return `${p.gate}: ${p.denied_tool} on ${p.denied_path || "?"} — ${p.reason || ""}`.slice(0, 140);
    case "prompt_serve": return `${p.served ?? "?"} served${p.plan_path ? ` (plan ${p.plan_path.split("/").pop()})` : ""}`;
    case "plan_serve": return `${(p.served || []).length} skills for ${String(p.plan_path || "").split("/").pop()}${p.cache_hit ? " (cache hit)" : ""}`;
    case "reindex": return `indexed ${p.indexed ?? "?"}`;
    default: return JSON.stringify(p).slice(0, 120);
  }
}

function HookErrors() {
  const s = state.logs;
  if (s.hookErrors === null) {
    s.hookErrors = false;
    api("/api/local/hook-errors?limit=50")
      .then((body) => update((st) => { st.logs.hookErrors = body.errors; }))
      .catch(() => update((st) => { st.logs.hookErrors = []; }));
  }
  const rows = s.hookErrors || [];
  return html`
    <details class="session">
      <summary>hook transport errors <span class="muted">last ${rows.length} — curl failures from ~/.betterai/hook-errors.log</span></summary>
      <table class="events"><tbody>
        ${rows.map((row) => html`
          <tr><td class="ts">${fmtTs(row.ts)}</td><td>${row.hook}</td><td>curl_exit=${row.curl_exit}</td></tr>`)}
      </tbody></table>
    </details>`;
}

function fmtTs(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return isNaN(d) ? ts : d.toLocaleString();
}
