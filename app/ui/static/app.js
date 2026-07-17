// BetterAI dashboard shell: hash router, fetch helpers, stats strip.
// Global-state + full re-render on purpose (no hooks, no build step):
// one state object, `update()` re-renders the tree — predictable and
// small at this app's scale.
import { h, render } from "preact";
import htm from "htm";
import { SkillsPage } from "/pages/skills.js";
import { LogsPage } from "/pages/logs.js";
import { DoctorPage } from "/pages/doctor.js";

export const html = htm.bind(h);

export const state = {
  page: location.hash.replace(/^#\/?/, "") || "skills",
  stats: null,
  error: null, // last {error, message} envelope, shown as a banner
  skills: { rows: null, query: "", type: "", detail: null, tab: "rendered", raw: null, form: null, saving: false, notice: null },
  logs: { events: null, total: 0, eventType: "", session: "", expanded: {}, hookErrors: null },
  doctor: { report: null, running: false },
};

export function update(mutate) {
  if (mutate) mutate(state);
  render(App(), document.getElementById("app"));
}

// Fetch helper: resolves JSON on 2xx, throws the server's typed
// envelope ({error: "BAI-xxx", message}) otherwise so callers surface
// it verbatim — never a silent fallback.
export async function api(path, options = {}) {
  if (options.body !== undefined && typeof options.body !== "string") {
    options = { ...options, body: JSON.stringify(options.body), headers: { "Content-Type": "application/json", ...options.headers } };
  }
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({ error: "UI", message: `non-JSON response (${response.status})` }));
  if (!response.ok) throw body;
  return body;
}

export function showError(envelope) {
  update((s) => { s.error = envelope; });
}

const PAGES = { skills: SkillsPage, logs: LogsPage, doctor: DoctorPage };

function App() {
  const Page = PAGES[state.page] || SkillsPage;
  return html`
    <header>
      <span class="brand">BetterAI</span>
      <nav>
        ${Object.keys(PAGES).map((name) => html`
          <a href="#/${name}" class=${state.page === name ? "active" : ""}>${name}</a>`)}
      </nav>
    </header>
    ${StatsStrip()}
    ${state.error && html`
      <div class="banner error" onclick=${() => update((s) => { s.error = null; })}>
        <b>${state.error.error}</b> ${state.error.message} <span class="dismiss">dismiss</span>
      </div>`}
    <main>${Page()}</main>
  `;
}

function StatsStrip() {
  const stats = state.stats;
  if (!stats) return html`<div class="stats" />`;
  const chips = [
    ["prompts served · 7d", stats.prompts_served_7d],
    ["skills served · 7d", stats.skills_served_7d],
    ["gate denials · 7d", stats.gate_denials_7d],
    ["hook errors · 24h", stats.hook_errors_24h],
    ["corpus", `${stats.corpus.rules} rules / ${stats.corpus.skills} skills`],
    ["plan cache · 7d", `${stats.plan_cache.hits_7d}/${stats.plan_cache.serves_7d} hits`],
  ];
  return html`
    <div class="stats">
      ${chips.map(([label, value]) => html`
        <div class="chip"><span class="value">${value}</span><span class="label">${label}</span></div>`)}
    </div>`;
}

window.addEventListener("hashchange", () => {
  update((s) => { s.page = location.hash.replace(/^#\/?/, "") || "skills"; s.error = null; });
});

api("/api/local/stats").then((stats) => update((s) => { s.stats = stats; })).catch(() => {});
update();
