import fs from "node:fs";
import path from "node:path";
import express from "express";
import multer from "multer";
import { config, isConfigured, missingEnv, ATTACHMENTS_DIR, DATA_DIR, TEMPLATES_DIR, ROOT } from "./src/config.js";
import { parseRecipients } from "./src/recipients.js";
import { renderMessage, MERGE_FIELDS } from "./src/template.js";
import { listAttachments, verifyTransport, fromAddress } from "./src/mailer.js";
import { ledgerStats, sentToday, readLedger } from "./src/ledger.js";
import { createJob, getJob, abortJob } from "./src/job.js";

fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(ROOT, "public")));

const upload = multer({
  limits: { fileSize: 25 * 1024 * 1024 }, // Gmail rejects attachments beyond ~25MB
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, ATTACHMENTS_DIR),
    // basename + whitelist: a crafted filename must not escape attachments/
    filename: (_req, file, cb) => cb(null, path.basename(file.originalname).replace(/[^\w.\-() ]/g, "_")),
  }),
});

const wrap = (handler) => (req, res) => {
  Promise.resolve(handler(req, res)).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: String(err.message || err) });
  });
};

app.get(
  "/api/config",
  wrap((_req, res) => {
    res.json({
      isConfigured,
      missing: missingEnv(),
      from: isConfigured ? fromAddress() : null,
      replyTo: config.replyTo,
      throttleMs: config.throttleMs,
      dailyCap: config.dailyCap,
      sentToday: sentToday(),
      mergeFields: MERGE_FIELDS,
      attachments: listAttachments(),
      ledger: ledgerStats(),
    });
  })
);

app.get(
  "/api/verify",
  wrap(async (_req, res) => {
    if (!isConfigured) {
      return res.status(400).json({ ok: false, error: `Missing in mailer/.env: ${missingEnv().join(", ")}` });
    }
    try {
      await verifyTransport();
      res.json({ ok: true, from: fromAddress() });
    } catch (err) {
      res.status(400).json({ ok: false, error: String(err.message || err) });
    }
  })
);

app.get(
  "/api/template",
  wrap((_req, res) => {
    const file = path.join(TEMPLATES_DIR, "outreach.html");
    res.json({ html: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "" });
  })
);

app.post(
  "/api/recipients/parse",
  wrap((req, res) => {
    const { text = "", campaign = "" } = req.body || {};
    res.json(parseRecipients(text, { campaign }));
  })
);

app.post(
  "/api/attachments",
  upload.array("files", 10),
  wrap((req, res) => {
    res.json({ uploaded: (req.files || []).map((f) => f.filename), attachments: listAttachments() });
  })
);

app.post(
  "/api/preview",
  wrap((req, res) => {
    const { subject = "", bodyHtml = "", recipients = [], count = 3 } = req.body || {};
    if (!subject.trim()) return res.status(400).json({ error: "Subject is empty" });
    if (!bodyHtml.trim()) return res.status(400).json({ error: "Body is empty" });
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: "No recipients to preview" });
    }
    const previews = recipients.slice(0, Math.max(1, count)).map((recipient) => ({
      recipient,
      ...renderMessage({ subject, bodyHtml }, recipient),
    }));
    res.json({ previews, total: recipients.length });
  })
);

app.post(
  "/api/send",
  wrap((req, res) => {
    const {
      recipients = [],
      subject = "",
      bodyHtml = "",
      attachments = [],
      throttleMs = config.throttleMs,
      campaign = "",
      dryRun = false,
      force = false,
    } = req.body || {};

    if (!Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: "No recipients" });
    }
    if (!subject.trim() || !bodyHtml.trim()) return res.status(400).json({ error: "Subject and body are required" });
    if (!dryRun && !isConfigured) {
      return res.status(400).json({ error: `SMTP not configured. Missing in mailer/.env: ${missingEnv().join(", ")}` });
    }
    if (!dryRun && !force) {
      const projected = sentToday() + recipients.length;
      if (projected > config.dailyCap) {
        return res.status(409).json({
          error: "daily_cap",
          message: `This run would reach ${projected} sends today, past the ${config.dailyCap} cap. Gmail may block the account.`,
          sentToday: sentToday(),
          dailyCap: config.dailyCap,
        });
      }
    }

    const job = createJob({
      recipients,
      subject,
      bodyHtml,
      attachments,
      throttleMs: Math.max(0, Number(throttleMs) || 0),
      campaign,
      dryRun: Boolean(dryRun),
    });
    res.json({ jobId: job.id, total: job.total, dryRun: job.dryRun });
  })
);

app.get("/api/send/:jobId/stream", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Unknown job" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const write = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  job.log.forEach(write); // replay anything emitted before this client connected
  if (job.state === "done" || job.state === "aborted" || job.state === "error") return res.end();

  const onEvent = (event) => {
    write(event);
    if (event.type === "done") {
      job.events.off("event", onEvent);
      res.end();
    }
  };
  job.events.on("event", onEvent);
  req.on("close", () => job.events.off("event", onEvent));
});

app.post(
  "/api/send/:jobId/abort",
  wrap((req, res) => {
    res.json({ ok: abortJob(req.params.jobId) });
  })
);

app.get(
  "/api/ledger",
  wrap((_req, res) => {
    res.json({ stats: ledgerStats(), entries: readLedger().slice(-200).reverse() });
  })
);

// Surface multer/body errors as JSON instead of an HTML stack trace.
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).json({ error: String(err.message || err) });
});

// Localhost only: this process holds live SMTP credentials.
app.listen(config.port, "127.0.0.1", () => {
  console.log(`\n  HR Mail Blaster  →  http://localhost:${config.port}\n`);
  if (isConfigured) {
    console.log(`  Sending as: ${fromAddress()}`);
  } else {
    console.log(`  SMTP not configured (missing ${missingEnv().join(", ")}) — dry run only.`);
    console.log("  See mailer/README.md for the Gmail App Password steps.\n");
  }
});
