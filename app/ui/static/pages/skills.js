// Skills manager: browse/search the corpus, read bodies, edit via the
// structured form (YAML never touches the browser — the server renders
// frontmatter), configure declared settings, add new skills.
import { html, api, state, update, showError } from "/app.js";
import { marked } from "marked";

const EMPTY_FORM = {
  id: "", artifact_type: "skill", category: "", title: "", severity: "",
  domain: "", when_to_use: "", forced: false, body: "", scope: "global", isNew: true,
};

export function SkillsPage() {
  const s = state.skills;
  if (s.rows === null) {
    s.rows = false; // fetch-in-flight marker
    api("/api/skills")
      .then((body) => update((st) => { st.skills.rows = body.artifacts; }))
      .catch((err) => { showError(err); update((st) => { st.skills.rows = []; }); });
  }
  const rows = (s.rows || []).filter((row) =>
    (!s.type || row.artifact_type === s.type) &&
    (!s.query || `${row.id} ${row.title} ${row.category}`.toLowerCase().includes(s.query.toLowerCase())));
  return html`
    <div class="split">
      <section class="list-pane">
        <div class="toolbar">
          <input placeholder="search skills + rules…" value=${s.query}
            onInput=${(e) => update((st) => { st.skills.query = e.target.value; })} />
          <select value=${s.type} onChange=${(e) => update((st) => { st.skills.type = e.target.value; })}>
            <option value="">all</option><option value="skill">skills</option><option value="rule">rules</option>
          </select>
          <button onclick=${() => openForm(EMPTY_FORM)}>new skill</button>
          <button onclick=${() => openForm({ ...EMPTY_FORM, pasteMode: true })}>paste markdown</button>
        </div>
        ${s.rows === false && html`<p class="muted">loading…</p>`}
        <table>
          <thead><tr><th>id</th><th>type</th><th>category</th><th>sev</th><th></th></tr></thead>
          <tbody>
            ${rows.map((row) => html`
              <tr class=${s.detail && s.detail.id === row.id ? "selected" : ""} onclick=${() => openDetail(row.id)}>
                <td><code>${row.id}</code>${row.forced && html` <span class="tag">forced</span>`}</td>
                <td>${row.artifact_type}</td><td>${row.category}</td><td>${row.severity || "—"}</td>
                <td>${row.scope}</td>
              </tr>`)}
          </tbody>
        </table>
        <p class="muted">${rows.length} of ${(s.rows || []).length} artifacts</p>
      </section>
      ${s.form ? FormPane() : s.detail ? DetailPane() : html`<section class="detail-pane muted"><p>Select an artifact.</p></section>`}
    </div>`;
}

function openDetail(id) {
  update((st) => { st.skills.form = null; st.skills.detail = { id, loading: true }; st.skills.tab = "rendered"; st.skills.raw = null; });
  api(`/api/skills/${id}`)
    .then((artifact) => update((st) => { st.skills.detail = artifact; }))
    .catch((err) => { showError(err); update((st) => { st.skills.detail = null; }); });
}

function openForm(seed) {
  update((st) => { st.skills.detail = null; st.skills.notice = null; st.skills.form = { ...seed }; });
}

function DetailPane() {
  const s = state.skills;
  const artifact = s.detail;
  if (artifact.loading) return html`<section class="detail-pane muted"><p>loading…</p></section>`;
  if (s.tab === "raw" && s.raw === null) {
    s.raw = false;
    api(`/api/skills/${artifact.id}/raw`)
      .then((body) => update((st) => { st.skills.raw = body; }))
      .catch(showError);
  }
  return html`
    <section class="detail-pane">
      <div class="detail-head">
        <h2><code>${artifact.id}</code></h2>
        <div>
          ${["rendered", "raw"].map((tab) => html`
            <button class=${s.tab === tab ? "active" : ""} onclick=${() => update((st) => { st.skills.tab = tab; })}>${tab}</button>`)}
          <button onclick=${() => openForm({ ...EMPTY_FORM, ...artifact, severity: artifact.severity || "", domain: artifact.domain || "", when_to_use: artifact.when_to_use || "", isNew: false })}>edit</button>
        </div>
      </div>
      <p class="muted">${artifact.artifact_type} · ${artifact.category} · ${artifact.scope}
        ${artifact.severity && ` · ${artifact.severity}`}${artifact.forced && " · forced"}</p>
      ${artifact.when_to_use && html`<p><i>${artifact.when_to_use}</i></p>`}
      ${s.tab === "rendered"
        ? html`<article dangerouslySetInnerHTML=${{ __html: marked.parse(artifact.body || "") }} />`
        : html`<pre>${s.raw ? s.raw.markdown : "loading…"}</pre>`}
      ${SettingsForm(artifact)}
    </section>`;
}

function SettingsForm(artifact) {
  const schema = artifact.settings_schema;
  if (!schema) return null;
  const current = artifact.settings || {};
  const values = {};
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api(`/api/skills/${artifact.id}/settings`, { method: "POST", body: { settings: values } });
      openDetail(artifact.id);
    } catch (err) { showError(err); }
  };
  return html`
    <form class="settings" onSubmit=${submit}>
      <h3>settings</h3>
      ${Object.entries(schema).map(([key, spec]) => html`
        <label>${key} <span class="muted">${spec.description || ""}</span>
          ${spec.choices
            ? html`<select onChange=${(e) => { values[key] = e.target.value; }}>
                ${spec.choices.map((choice) => html`
                  <option selected=${(current[key] ?? spec.default) === choice}>${choice}</option>`)}
              </select>`
            : html`<input value=${current[key] ?? spec.default ?? ""} onInput=${(e) => { values[key] = e.target.value; }} />`}
        </label>`)}
      <button type="submit">save settings</button>
    </form>`;
}

function FormPane() {
  const s = state.skills;
  const form = s.form;
  const bind = (key) => (e) => update((st) => { st.skills.form[key] = e.target.type === "checkbox" ? e.target.checked : e.target.value; });
  const submit = async (e) => {
    e.preventDefault();
    update((st) => { st.skills.saving = true; });
    try {
      let result;
      if (form.pasteMode) {
        result = await api("/api/skills/markdown", { method: "POST", body: { markdown: form.body, forced: form.forced || undefined } });
      } else {
        const artifact = {
          id: form.id, artifact_type: form.artifact_type, category: form.category, title: form.title,
          forced: !!form.forced, body: form.body,
          ...(form.severity && { severity: form.severity }), ...(form.domain && { domain: form.domain }),
          ...(form.when_to_use && { when_to_use: form.when_to_use }),
        };
        result = await api(form.isNew ? "/api/skills" : `/api/skills/${form.id}`, {
          method: form.isNew ? "POST" : "PUT", body: { artifact, scope: form.scope || "global" },
        });
      }
      update((st) => { st.skills.saving = false; st.skills.form = null; st.skills.rows = null; st.skills.notice = `saved ${result.id}`; });
      openDetail(result.id);
    } catch (err) {
      update((st) => { st.skills.saving = false; });
      showError(err);
    }
  };
  return html`
    <section class="detail-pane">
      <h2>${form.pasteMode ? "add from markdown" : form.isNew ? "new skill" : `edit ${form.id}`}</h2>
      <form class="editor" onSubmit=${submit}>
        ${form.pasteMode
          ? html`<label>markdown (frontmatter + body; missing facets are classified server-side)
              <textarea rows="18" required value=${form.body} onInput=${bind("body")} /></label>`
          : html`
            <div class="grid">
              <label>id <input required pattern="[a-z0-9]+(-[a-z0-9]+)*" value=${form.id} onInput=${bind("id")} disabled=${!form.isNew} /></label>
              <label>type <select value=${form.artifact_type} onChange=${bind("artifact_type")}>
                <option>skill</option><option>rule</option></select></label>
              <label>category <input required value=${form.category} onInput=${bind("category")} /></label>
              <label>title <input required value=${form.title} onInput=${bind("title")} /></label>
              <label>severity <select value=${form.severity} onChange=${bind("severity")}>
                <option value="">—</option><option>low</option><option>medium</option><option>high</option></select></label>
              <label>domain <input value=${form.domain} onInput=${bind("domain")} /></label>
              <label>scope <select value=${form.scope} onChange=${bind("scope")}>
                <option>global</option><option>repo</option></select></label>
              <label class="row">forced <input type="checkbox" checked=${form.forced} onChange=${bind("forced")} /></label>
            </div>
            <label>when to use <input value=${form.when_to_use} onInput=${bind("when_to_use")} /></label>
            <label>body <textarea rows="14" required value=${form.body} onInput=${bind("body")} /></label>`}
        <div class="row">
          <button type="submit" disabled=${s.saving}>${s.saving ? "saving…" : "save"}</button>
          <button type="button" onclick=${() => update((st) => { st.skills.form = null; })}>cancel</button>
        </div>
      </form>
    </section>`;
}
