/* HR Mail Blaster — dashboard client. No framework, no build step. */

const $ = (id) => document.getElementById(id);

const el = {
  statusPill: $("statusPill"),
  statusMeta: $("statusMeta"),
  setupBanner: $("setupBanner"),
  setupBannerText: $("setupBannerText"),
  campaign: $("campaign"),
  recipients: $("recipients"),
  csvInput: $("csvInput"),
  parseBtn: $("parseBtn"),
  report: $("report"),
  subject: $("subject"),
  body: $("body"),
  mergeChips: $("mergeChips"),
  loadTemplateBtn: $("loadTemplateBtn"),
  attachments: $("attachments"),
  attachInput: $("attachInput"),
  throttle: $("throttle"),
  dryRunBtn: $("dryRunBtn"),
  sendBtn: $("sendBtn"),
  gate: $("gate"),
  previewPanel: $("previewPanel"),
  previewFrame: $("previewFrame"),
  previewTo: $("previewTo"),
  previewSubject: $("previewSubject"),
  previewAttach: $("previewAttach"),
  previewText: $("previewText"),
  previewCounter: $("previewCounter"),
  prevRecipient: $("prevRecipient"),
  nextRecipient: $("nextRecipient"),
  logPanel: $("logPanel"),
  log: $("log"),
  tally: $("tally"),
  progressBar: $("progressBar"),
  abortBtn: $("abortBtn"),
  failedCsvBtn: $("failedCsvBtn"),
  overlay: $("overlay"),
  modalTitle: $("modalTitle"),
  modalBody: $("modalBody"),
  modalCancel: $("modalCancel"),
  modalConfirm: $("modalConfirm"),
};

const state = {
  config: null,
  recipients: [],
  report: null,
  previews: [],
  previewIndex: 0,
  /** Signature of what was last previewed; the Send button only unlocks while it matches. */
  previewedSignature: null,
  jobId: null,
  results: [],
  lastFocused: null,
  sending: false,
};

/* ── helpers ──────────────────────────────────────────────────────────── */

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    ...options,
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Server returned non-JSON (${res.status}): ${text.slice(0, 120)}`);
  }
  if (!res.ok) {
    const err = new Error(data.message || data.error || `Request failed (${res.status})`);
    err.payload = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function selectedAttachments() {
  return [...el.attachments.querySelectorAll("input[type=checkbox]:checked")].map((c) => c.value);
}

function signature() {
  return JSON.stringify({
    subject: el.subject.value,
    body: el.body.value,
    emails: state.recipients.map((r) => r.email),
    attachments: selectedAttachments(),
  });
}

function refreshGate() {
  const ready =
    !state.sending && state.previewedSignature !== null && state.previewedSignature === signature() && state.recipients.length > 0;
  el.sendBtn.disabled = !ready;

  const n = state.recipients.length;
  el.sendBtn.textContent = n ? `Send to ${n}` : "Send";

  if (state.sending) {
    el.gate.textContent = "Sending…";
    el.gate.className = "gate";
  } else if (ready) {
    el.gate.textContent = `Reviewed. ${n} ${n === 1 ? "email" : "emails"} ready to send for real.`;
    el.gate.className = "gate gate--ready";
  } else if (state.previewedSignature !== null) {
    el.gate.textContent = "Message changed since the last dry run — run it again.";
    el.gate.className = "gate";
  } else {
    el.gate.textContent = "Run a dry run first — the send button unlocks after you've seen the preview.";
    el.gate.className = "gate";
  }
}

/* ── config / status ──────────────────────────────────────────────────── */

async function loadConfig() {
  const cfg = await api("/api/config");
  state.config = cfg;

  if (cfg.isConfigured) {
    el.statusPill.textContent = "smtp ready";
    el.statusPill.className = "pill pill--ok";
    el.statusMeta.textContent = cfg.from || "";
    el.setupBanner.hidden = true;
  } else {
    el.statusPill.textContent = "dry run only";
    el.statusPill.className = "pill pill--warn";
    el.statusMeta.textContent = "";
    el.setupBanner.hidden = false;
    el.setupBannerText.textContent = ` Missing ${cfg.missing.join(" and ")}. `;
  }

  const capLeft = cfg.dailyCap - cfg.sentToday;
  el.statusMeta.textContent += `${el.statusMeta.textContent ? "  ·  " : ""}${cfg.sentToday}/${cfg.dailyCap} sent today (${capLeft} left)`;

  if (!el.throttle.value) el.throttle.value = cfg.throttleMs;
  renderAttachments(cfg.attachments);
  renderMergeChips(cfg.mergeFields);
}

function renderMergeChips(fields) {
  el.mergeChips.innerHTML = "";
  const label = document.createElement("span");
  label.className = "chips-label";
  label.textContent = "Insert:";
  el.mergeChips.append(label);

  for (const field of fields) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = `{{${field}}}`;
    chip.title = `Personalized from the ${field} column`;
    chip.addEventListener("click", () => insertAtCursor(`{{${field}}}`));
    el.mergeChips.append(chip);
  }
}

function insertAtCursor(text) {
  const target = state.lastFocused === el.subject ? el.subject : el.body;
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? target.value.length;
  target.value = target.value.slice(0, start) + text + target.value.slice(end);
  target.focus();
  target.selectionStart = target.selectionEnd = start + text.length;
  refreshGate();
}

function renderAttachments(list) {
  const previouslyChecked = new Set(selectedAttachments());
  el.attachments.innerHTML = "";

  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No files yet — upload one, or drop files into mailer/attachments/";
    el.attachments.append(empty);
    return;
  }

  for (const file of list) {
    const row = document.createElement("label");
    row.className = "attach-row";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = file.name;
    // Resume prior selection; otherwise pre-tick a resume, which is the usual attachment.
    box.checked = previouslyChecked.size ? previouslyChecked.has(file.name) : /resume|cv/i.test(file.name);
    box.addEventListener("change", refreshGate);

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = file.name;

    const size = document.createElement("span");
    size.className = "size";
    size.textContent = fmtBytes(file.size);

    row.append(box, name, size);
    el.attachments.append(row);
  }
}

/* ── recipients ───────────────────────────────────────────────────────── */

function tag(cls, label, count, detail) {
  const node = document.createElement("span");
  node.className = `tag ${cls}`;
  node.innerHTML = "";
  const b = document.createElement("b");
  b.textContent = String(count);
  node.append(b, document.createTextNode(` ${label}`));
  if (detail) {
    node.dataset.detail = "1";
    node.title = detail;
  }
  return node;
}

function renderReport() {
  const { report, recipients } = state;
  el.report.innerHTML = "";
  if (!report) return;

  el.report.append(tag(recipients.length ? "tag--ok" : "", recipients.length === 1 ? "recipient" : "recipients", recipients.length));

  const buckets = [
    ["invalid", "invalid — skipped", "tag--err"],
    ["duplicates", "duplicate — skipped", "tag--warn"],
    ["suppressed", "on suppression list", "tag--warn"],
    ["alreadySent", "already mailed this campaign", "tag--warn"],
  ];

  for (const [key, label, cls] of buckets) {
    const items = report[key] || [];
    if (items.length) el.report.append(tag(cls, label, items.length, items.slice(0, 20).join("\n")));
  }

  const missingName = recipients.filter((r) => !r.name).length;
  if (missingName) {
    el.report.append(tag("", `no name → “there” fallback`, missingName));
  }
}

let parseTimer = null;

async function parseRecipients() {
  const text = el.recipients.value;
  if (!text.trim()) {
    state.recipients = [];
    state.report = null;
    state.previewedSignature = null;
    renderReport();
    refreshGate();
    return;
  }
  const data = await api("/api/recipients/parse", {
    method: "POST",
    body: JSON.stringify({ text, campaign: el.campaign.value }),
  });
  state.recipients = data.recipients;
  state.report = data.report;
  renderReport();
  refreshGate();
}

const parseSoon = () => {
  clearTimeout(parseTimer);
  parseTimer = setTimeout(() => parseRecipients().catch(showError), 350);
};

/* ── preview ──────────────────────────────────────────────────────────── */

function showPreview(index) {
  const previews = state.previews;
  if (!previews.length) return;
  state.previewIndex = ((index % previews.length) + previews.length) % previews.length;
  const p = previews[state.previewIndex];

  el.previewPanel.hidden = false;
  el.previewTo.textContent = p.recipient.name ? `${p.recipient.name} <${p.recipient.email}>` : p.recipient.email;
  el.previewSubject.textContent = p.subject;
  const chosen = selectedAttachments();
  el.previewAttach.textContent = chosen.length ? chosen.join(", ") : "— none —";
  el.previewFrame.srcdoc = p.html;
  el.previewText.textContent = p.text;
  el.previewCounter.textContent = `${state.previewIndex + 1} / ${previews.length}`;
}

/* ── log ──────────────────────────────────────────────────────────────── */

function resetLog() {
  el.log.innerHTML = "";
  el.tally.innerHTML = "";
  el.progressBar.style.width = "0%";
  el.logPanel.hidden = false;
  el.failedCsvBtn.hidden = true;
  state.results = [];
}

const MARKS = { sent: "✓", preview: "◦", failed: "✗", retry: "↻", info: "·" };

function logRow(kind, index, who, note) {
  const row = document.createElement("div");
  row.className = `log-row log-row--${kind}`;

  const idx = document.createElement("span");
  idx.className = "idx";
  idx.textContent = index ? `${index}` : "";

  const mark = document.createElement("span");
  mark.className = "mark";
  mark.textContent = MARKS[kind] || "·";

  const target = document.createElement("span");
  target.className = "who";
  target.textContent = who;

  row.append(idx, mark, target);

  if (note) {
    const why = document.createElement("span");
    why.className = "why";
    why.textContent = note;
    why.title = note;
    row.append(why);
  }

  const atBottom = el.log.scrollTop + el.log.clientHeight >= el.log.scrollHeight - 30;
  el.log.append(row);
  if (atBottom) el.log.scrollTop = el.log.scrollHeight;
}

function renderTally({ sent = 0, failed = 0, skipped = 0, total = 0, dryRun = false }) {
  el.tally.innerHTML = "";
  el.tally.append(tag("tag--ok", dryRun ? "rendered" : "sent", sent));
  if (failed) el.tally.append(tag("tag--err", "failed", failed));
  if (skipped) el.tally.append(tag("tag--warn", "not attempted", skipped));
  el.tally.append(tag("", "total", total));
}

function stream(jobId, { dryRun }) {
  return new Promise((resolve) => {
    const source = new EventSource(`/api/send/${jobId}/stream`);
    let total = state.recipients.length;

    source.addEventListener("message", (event) => {
      const e = JSON.parse(event.data);

      if (e.type === "start") {
        total = e.total;
        logRow("info", null, dryRun ? `Dry run — ${total} recipients, nothing will be sent` : `Sending to ${total} recipients, ${e.throttleMs}ms apart`);
      } else if (e.type === "progress") {
        state.results.push(e);
        logRow(e.status, e.index, e.email, e.error || "");
        el.progressBar.style.width = `${Math.round((e.index / total) * 100)}%`;
        renderTally({
          sent: state.results.filter((r) => r.status === "sent" || r.status === "preview").length,
          failed: state.results.filter((r) => r.status === "failed").length,
          total,
          dryRun,
        });
      } else if (e.type === "retry") {
        logRow("retry", e.index, `${e.email} — retrying`, e.message);
      } else if (e.type === "aborted") {
        logRow("info", null, `Aborted — ${e.remaining} not attempted`);
      } else if (e.type === "error") {
        logRow("failed", null, e.message);
      } else if (e.type === "done") {
        renderTally({ ...e, dryRun });
        el.progressBar.style.width = "100%";
        logRow(
          "info",
          null,
          e.aborted
            ? `Stopped. ${e.sent} ${dryRun ? "rendered" : "sent"}, ${e.failed} failed, ${e.skipped} skipped.`
            : `Finished. ${e.sent} ${dryRun ? "rendered" : "sent"}, ${e.failed} failed.`
        );
        source.close();
        resolve(e);
      }
    });

    source.addEventListener("error", () => {
      // The server ends the stream after `done`; only treat it as fatal if we never finished.
      if (source.readyState === EventSource.CLOSED && !state.results.length) {
        logRow("failed", null, "Lost connection to the server");
        resolve({ sent: 0, failed: 0, skipped: 0, total, aborted: true });
      }
      source.close();
    });
  });
}

/* ── modal ────────────────────────────────────────────────────────────── */

function confirmModal({ title, html, confirmLabel = "Send" }) {
  return new Promise((resolve) => {
    el.modalTitle.textContent = title;
    el.modalBody.innerHTML = html;
    el.modalConfirm.textContent = confirmLabel;
    el.overlay.hidden = false;

    const cleanup = (result) => {
      el.overlay.hidden = true;
      el.modalConfirm.removeEventListener("click", onOk);
      el.modalCancel.removeEventListener("click", onNo);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onNo = () => cleanup(false);
    const onKey = (e) => {
      if (e.key === "Escape") cleanup(false);
    };

    el.modalConfirm.addEventListener("click", onOk);
    el.modalCancel.addEventListener("click", onNo);
    document.addEventListener("keydown", onKey);
  });
}

function showError(err) {
  console.error(err);
  el.logPanel.hidden = false;
  logRow("failed", null, String(err.message || err));
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ── actions ──────────────────────────────────────────────────────────── */

async function runJob({ dryRun, force = false }) {
  const payload = {
    recipients: state.recipients,
    subject: el.subject.value,
    bodyHtml: el.body.value,
    attachments: selectedAttachments(),
    throttleMs: Number(el.throttle.value) || 0,
    campaign: el.campaign.value,
    dryRun,
    force,
  };

  let job;
  try {
    job = await api("/api/send", { method: "POST", body: JSON.stringify(payload) });
  } catch (err) {
    if (err.payload?.error === "daily_cap") {
      const ok = await confirmModal({
        title: "Past the daily cap",
        html: `<p>${escapeHtml(err.message)}</p><p class="danger">Gmail can temporarily lock sending if you push past its limit. Consider splitting this across days.</p>`,
        confirmLabel: "Send anyway",
      });
      if (!ok) return null;
      return runJob({ dryRun, force: true });
    }
    throw err;
  }

  state.jobId = job.jobId;
  state.sending = true;
  el.abortBtn.hidden = dryRun;
  el.dryRunBtn.disabled = true;
  refreshGate();

  const result = await stream(job.jobId, { dryRun });

  state.sending = false;
  el.abortBtn.hidden = true;
  el.dryRunBtn.disabled = false;
  if (state.results.some((r) => r.status === "failed")) el.failedCsvBtn.hidden = false;
  return result;
}

async function onDryRun() {
  await parseRecipients();
  if (!state.recipients.length) {
    showError(new Error("No valid recipients to preview"));
    return;
  }

  const previewData = await api("/api/preview", {
    method: "POST",
    body: JSON.stringify({
      subject: el.subject.value,
      bodyHtml: el.body.value,
      recipients: state.recipients,
      count: Math.min(5, state.recipients.length),
    }),
  });
  state.previews = previewData.previews;
  showPreview(0);

  resetLog();
  await runJob({ dryRun: true });

  state.previewedSignature = signature();
  refreshGate();
  el.previewPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function onSend() {
  const chosen = selectedAttachments();
  const n = state.recipients.length;
  const cfg = state.config;

  const ok = await confirmModal({
    title: `Send ${n} real ${n === 1 ? "email" : "emails"}?`,
    html: `
      <p>Each recipient gets their own separate message. This cannot be undone.</p>
      <dl>
        <dt>From</dt><dd>${escapeHtml(cfg.from || "—")}</dd>
        <dt>Subject</dt><dd>${escapeHtml(el.subject.value)}</dd>
        <dt>Attached</dt><dd>${chosen.length ? escapeHtml(chosen.join(", ")) : "— nothing —"}</dd>
        <dt>Pace</dt><dd>one per ~${(Number(el.throttle.value) / 1000).toFixed(1)}s → about ${Math.max(1, Math.round((n * Number(el.throttle.value)) / 60000))} min</dd>
        <dt>Campaign</dt><dd>${escapeHtml(el.campaign.value || "— unnamed —")}</dd>
      </dl>
      ${chosen.length ? "" : '<p class="danger">No attachment selected — your resume will not be included.</p>'}
      ${el.campaign.value.trim() ? "" : '<p class="danger">No campaign name — the duplicate guard will treat future runs as the same campaign.</p>'}
    `,
    confirmLabel: `Send ${n}`,
  });
  if (!ok) return;

  resetLog();
  await runJob({ dryRun: false });
  await loadConfig(); // refresh today's count and the cap
  state.previewedSignature = null; // force a fresh review before any further sending
  refreshGate();
}

function downloadFailures() {
  const failed = state.results.filter((r) => r.status === "failed");
  const byEmail = new Map(state.recipients.map((r) => [r.email, r]));
  const rows = [
    "email,name,company,role,error",
    ...failed.map((f) => {
      const r = byEmail.get(f.email) || {};
      const cell = (v) => `"${String(v || "").replace(/"/g, '""')}"`;
      return [cell(f.email), cell(r.name), cell(r.company), cell(r.role), cell(f.error)].join(",");
    }),
  ];
  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "failed-recipients.csv";
  link.click();
  URL.revokeObjectURL(link.href);
}

/* ── wiring ───────────────────────────────────────────────────────────── */

el.recipients.addEventListener("input", parseSoon);
el.campaign.addEventListener("change", () => parseRecipients().catch(showError));
el.parseBtn.addEventListener("click", () => parseRecipients().catch(showError));

el.subject.addEventListener("focus", () => (state.lastFocused = el.subject));
el.body.addEventListener("focus", () => (state.lastFocused = el.body));
el.subject.addEventListener("input", refreshGate);
el.body.addEventListener("input", refreshGate);

el.csvInput.addEventListener("change", async () => {
  const file = el.csvInput.files?.[0];
  if (!file) return;
  const text = await file.text();
  el.recipients.value = el.recipients.value.trim() ? `${el.recipients.value.trim()}\n${text}` : text;
  el.csvInput.value = "";
  await parseRecipients().catch(showError);
});

el.attachInput.addEventListener("change", async () => {
  const files = [...(el.attachInput.files || [])];
  if (!files.length) return;
  const form = new FormData();
  files.forEach((f) => form.append("files", f));
  try {
    const data = await api("/api/attachments", { method: "POST", body: form });
    renderAttachments(data.attachments);
    el.attachInput.value = "";
    state.previewedSignature = null;
    refreshGate();
  } catch (err) {
    showError(err);
  }
});

el.loadTemplateBtn.addEventListener("click", async () => {
  const { html } = await api("/api/template");
  if (!html) return showError(new Error("templates/outreach.html is missing"));
  if (el.body.value.trim() && !window.confirm("Replace the current body with the starter template?")) return;
  el.body.value = html;
  if (!el.subject.value.trim()) el.subject.value = "Application for {{role}} at {{company}} — Harsh Jha";
  refreshGate();
});

el.dryRunBtn.addEventListener("click", () => {
  el.dryRunBtn.disabled = true;
  onDryRun()
    .catch(showError)
    .finally(() => {
      el.dryRunBtn.disabled = false;
    });
});

el.sendBtn.addEventListener("click", () => {
  el.sendBtn.disabled = true;
  onSend().catch(showError).finally(refreshGate);
});

el.abortBtn.addEventListener("click", async () => {
  el.abortBtn.disabled = true;
  await api(`/api/send/${state.jobId}/abort`, { method: "POST" }).catch(showError);
  logRow("info", null, "Abort requested — stopping after the current send");
  el.abortBtn.disabled = false;
});

el.prevRecipient.addEventListener("click", () => showPreview(state.previewIndex - 1));
el.nextRecipient.addEventListener("click", () => showPreview(state.previewIndex + 1));
el.failedCsvBtn.addEventListener("click", downloadFailures);

loadConfig().catch(showError);
refreshGate();
