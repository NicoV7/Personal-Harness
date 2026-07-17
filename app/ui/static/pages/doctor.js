// Install/doctor panel: host-side checks with fix hints, re-runnable.
import { html, api, state, update, showError } from "/app.js";

export function DoctorPage() {
  const s = state.doctor;
  if (s.report === null) run();
  const report = s.report || { checks: [], failures: 0 };
  return html`
    <div class="toolbar">
      <button onclick=${run} disabled=${s.running}>${s.running ? "running…" : "re-run checks"}</button>
      ${s.report && html`
        <span class=${report.failures ? "tag warn" : "tag ok"}>
          ${report.failures ? `${report.failures} failing` : "all checks pass"}
        </span>`}
    </div>
    <table class="doctor">
      <tbody>
        ${report.checks.map((check) => html`
          <tr>
            <td><span class="tag ${check.ok ? "ok" : check.advisory ? "warn" : "fail"}">
              ${check.ok ? "ok" : check.advisory ? "warn" : "fail"}</span></td>
            <td>
              <b>${check.label}</b>
              ${check.detail && html`<div class="muted">${check.detail}</div>`}
              ${!check.ok && check.fix_hint && html`<div class="fix">fix: <code>${check.fix_hint}</code></div>`}
            </td>
          </tr>`)}
      </tbody>
    </table>`;
}

function run() {
  update((st) => { st.doctor.running = true; if (st.doctor.report === null) st.doctor.report = false; });
  api("/api/local/doctor")
    .then((report) => update((st) => { st.doctor.report = report; st.doctor.running = false; }))
    .catch((err) => { showError(err); update((st) => { st.doctor.report = { checks: [], failures: 0 }; st.doctor.running = false; }); });
}
