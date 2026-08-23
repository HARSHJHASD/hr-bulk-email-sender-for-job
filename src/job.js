import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { renderMessage } from "./template.js";
import { sendOne, resolveAttachments, closeTransport } from "./mailer.js";
import { appendLedger } from "./ledger.js";

const jobs = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** ±30% jitter so the send pattern doesn't look machine-regular to Gmail. */
function jitter(ms) {
  const spread = ms * 0.3;
  return Math.max(0, Math.round(ms - spread + Math.random() * spread * 2));
}

function isTransient(err) {
  const code = err?.code || "";
  if (["ECONNRESET", "ETIMEDOUT", "ESOCKET", "ECONNECTION", "EDNS", "ECONNREFUSED"].includes(code)) return true;
  const response = Number(err?.responseCode);
  return Number.isFinite(response) && response >= 400 && response < 500;
}

export function createJob({
  recipients,
  subject,
  bodyHtml,
  attachments = [],
  throttleMs = config.throttleMs,
  campaign = "",
  dryRun = false,
}) {
  const id = randomUUID();
  const job = {
    id,
    events: new EventEmitter(),
    log: [], // replayed to SSE clients that connect after the job starts
    state: "running",
    dryRun,
    aborting: false,
    total: recipients.length,
    sent: 0,
    failed: 0,
    skipped: 0,
    results: [],
  };
  jobs.set(id, job);

  const emit = (type, payload) => {
    const event = { type, at: new Date().toISOString(), ...payload };
    job.log.push(event);
    job.events.emit("event", event);
  };

  const run = async () => {
    let resolved = [];
    try {
      resolved = dryRun ? [] : resolveAttachments(attachments);
    } catch (err) {
      job.state = "error";
      emit("error", { message: err.message });
      emit("done", { sent: 0, failed: 0, skipped: 0, total: job.total, aborted: false });
      return;
    }

    emit("start", { total: job.total, dryRun, throttleMs, campaign, attachments });

    for (let i = 0; i < recipients.length; i += 1) {
      if (job.aborting) {
        job.skipped = recipients.length - i;
        emit("aborted", { remaining: job.skipped });
        break;
      }

      const recipient = recipients[i];
      const message = renderMessage({ subject, bodyHtml }, recipient);
      const base = { index: i + 1, email: recipient.email, name: recipient.name, subject: message.subject };

      if (dryRun) {
        job.sent += 1;
        job.results.push({ ...base, status: "preview" });
        emit("progress", { ...base, status: "preview" });
        continue;
      }

      let messageId = null;
      let lastError = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          messageId = await sendOne({
            to: recipient.email,
            subject: message.subject,
            html: message.html,
            text: message.text,
            attachments: resolved,
          });
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          if (attempt === 1 && isTransient(err)) {
            emit("retry", { ...base, message: err.message });
            await sleep(3000);
            continue;
          }
          break;
        }
      }

      const status = lastError ? "failed" : "sent";
      const entry = {
        email: recipient.email,
        name: recipient.name,
        company: recipient.company,
        role: recipient.role,
        campaign,
        status,
        messageId,
        error: lastError ? String(lastError.message || lastError) : null,
        timestamp: new Date().toISOString(),
      };
      appendLedger(entry);

      if (lastError) job.failed += 1;
      else job.sent += 1;
      job.results.push({ ...base, status, messageId, error: entry.error });
      emit("progress", { ...base, status, messageId, error: entry.error });

      const isLast = i === recipients.length - 1;
      if (!isLast && !job.aborting && throttleMs > 0) await sleep(jitter(throttleMs));
    }

    if (!dryRun) closeTransport();
    job.state = job.aborting ? "aborted" : "done";
    emit("done", {
      sent: job.sent,
      failed: job.failed,
      skipped: job.skipped,
      total: job.total,
      aborted: job.aborting,
    });
  };

  // Kick off without blocking the HTTP response; failures still surface over SSE.
  run().catch((err) => {
    job.state = "error";
    emit("error", { message: String(err.message || err) });
    emit("done", { sent: job.sent, failed: job.failed, skipped: job.skipped, total: job.total, aborted: false });
  });

  return job;
}

export const getJob = (id) => jobs.get(id);

export function abortJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job.aborting = true;
  return true;
}
