import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startFakeSmtp } from "./fake-smtp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAILER = path.resolve(HERE, "..");

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/** Reads an SSE response to completion and returns every event object. */
async function collectStream(url) {
  const res = await fetch(url);
  assert.equal(res.status, 200, "stream should open");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (line) events.push(JSON.parse(line.slice(6)));
    }
  }
  return events;
}

test("end-to-end: dashboard API sends real SMTP mail with an attachment", async (t) => {
  const smtp = await startFakeSmtp({ failFor: ["bounce@nowhere.com"] });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "blaster-data-"));
  const attachDir = fs.mkdtempSync(path.join(os.tmpdir(), "blaster-attach-"));
  fs.writeFileSync(path.join(attachDir, "resume.pdf"), "%PDF-1.4 pretend resume\n");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  const server = spawn(process.execPath, ["server.js"], {
    cwd: MAILER,
    env: {
      ...process.env,
      PORT: String(port),
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(smtp.port),
      SMTP_USER: "harsh@test.local",
      SMTP_PASS: "abcd efgh ijkl mnop",
      FROM_NAME: "Harsh Jha",
      REPLY_TO: "harsh@test.local",
      DATA_DIR: dataDir,
      ATTACHMENTS_DIR: attachDir,
      THROTTLE_MS: "0",
      DAILY_CAP: "100",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));

  t.after(async () => {
    server.kill();
    await smtp.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(attachDir, { recursive: true, force: true });
  });

  // wait for boot
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${base}/api/config`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  const post = (route, body) =>
    fetch(`${base}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  await t.test("reports itself configured and lists the attachment", async () => {
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg.isConfigured, true, `expected configured. server said:\n${serverLog}`);
    assert.equal(cfg.from, '"Harsh Jha" <harsh@test.local>');
    assert.deepEqual(
      cfg.attachments.map((a) => a.name),
      ["resume.pdf"]
    );
  });

  await t.test("SMTP pre-flight check passes", async () => {
    const verify = await (await fetch(`${base}/api/verify`)).json();
    assert.equal(verify.ok, true);
  });

  const listText = [
    "Email,Name,Company,Role",
    "priya@acme.com,Priya Sharma,Acme Corp,SDE-1",
    "hr@globex.com,,Globex,Frontend Engineer",
    "bounce@nowhere.com,Nobody,Nowhere,QA",
    "not-an-email,,,",
  ].join("\n");

  let recipients;
  await t.test("parses the pasted list and flags the bad row", async () => {
    const parsed = await (await post("/api/recipients/parse", { text: listText, campaign: "aug" })).json();
    recipients = parsed.recipients;
    assert.equal(recipients.length, 3);
    assert.equal(parsed.report.invalid.length, 1);
  });

  const message = {
    subject: "Application for {{role}} at {{company}} — Harsh Jha",
    bodyHtml: "<p>Hi {{name}},</p><p>Re the {{role}} role at {{company}}.</p>",
  };

  await t.test("preview personalizes per recipient without sending", async () => {
    const { previews } = await (await post("/api/preview", { ...message, recipients })).json();
    assert.equal(previews[0].subject, "Application for SDE-1 at Acme Corp — Harsh Jha");
    assert.match(previews[0].html, /Hi Priya Sharma,/);
    // blank name falls back
    assert.match(previews[1].html, /Hi there,/);
    assert.equal(smtp.messages.length, 0, "preview must not send");
  });

  await t.test("dry run streams progress and still sends nothing", async () => {
    const job = await (await post("/api/send", { ...message, recipients, throttleMs: 0, campaign: "aug", dryRun: true })).json();
    const events = await collectStream(`${base}/api/send/${job.jobId}/stream`);
    const done = events.at(-1);
    assert.equal(done.type, "done");
    assert.equal(done.sent, 3);
    assert.equal(smtp.messages.length, 0, "dry run must not touch SMTP");
    const ledger = path.join(dataDir, "sent-log.jsonl");
    assert.equal(fs.existsSync(ledger), false, "dry run must not write the ledger");
    assert.equal(fs.existsSync(path.join(dataDir, "campaigns")), false, "dry run must not write an archive");
  });

  await t.test("real send delivers one message per recipient, with the attachment", async () => {
    const job = await (
      await post("/api/send", {
        ...message,
        recipients,
        attachments: ["resume.pdf"],
        throttleMs: 0,
        campaign: "aug",
        dryRun: false,
      })
    ).json();
    const events = await collectStream(`${base}/api/send/${job.jobId}/stream`);
    const done = events.at(-1);

    assert.equal(done.type, "done");
    assert.equal(done.sent, 2, "two good addresses");
    assert.equal(done.failed, 1, "the rejected address is reported, not fatal");

    // Three separate SMTP transactions, each with exactly one recipient — never bundled.
    assert.equal(smtp.messages.length, 3);
    for (const m of smtp.messages) assert.equal(m.to.length, 1);

    const toPriya = smtp.messages.find((m) => m.to[0] === "priya@acme.com");
    assert.ok(toPriya, "Priya's message reached the server");
    assert.match(toPriya.data, /Subject: .*SDE-1/);
    assert.match(toPriya.data, /From: Harsh Jha <harsh@test.local>/);
    assert.match(toPriya.data, /Reply-To: harsh@test.local/);
    assert.match(toPriya.data, /filename="?resume\.pdf"?/, "attachment present");
    assert.match(toPriya.data, /Content-Type: multipart\/alternative/, "html + text alternative");
    assert.match(toPriya.data, /Hi Priya Sharma,/);

    const toGlobex = smtp.messages.find((m) => m.to[0] === "hr@globex.com");
    assert.match(toGlobex.data, /Hi there,/, "blank name falls back in the real send too");
  });

  await t.test("ledger records the outcome and blocks a repeat of the same campaign", async () => {
    const entries = fs
      .readFileSync(path.join(dataDir, "sent-log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(entries.length, 3);
    assert.equal(entries.filter((e) => e.status === "sent").length, 2);
    assert.equal(entries.filter((e) => e.status === "failed").length, 1);

    const parsed = await (await post("/api/recipients/parse", { text: listText, campaign: "aug" })).json();
    assert.equal(parsed.report.alreadySent.length, 2, "the two successes are now skipped");
    assert.equal(parsed.recipients.length, 1, "the failure remains available to retry");
  });

  await t.test("archives the run: subject, body, attachment and recipient list on disk", async () => {
    const campaignsDir = path.join(dataDir, "campaigns");
    const runs = fs.readdirSync(campaignsDir);
    const dir = runs
      .map((name) => path.join(campaignsDir, name))
      .find((full) => JSON.parse(fs.readFileSync(path.join(full, "manifest.json"), "utf8")).campaign === "aug");
    assert.ok(dir, "an archive folder exists for campaign 'aug'");

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    assert.equal(manifest.subject, message.subject);
    assert.deepEqual(
      manifest.attachments.map((a) => a.name),
      ["resume.pdf"]
    );
    assert.equal(manifest.counts.total, 3);
    assert.equal(manifest.counts.sent, 2);
    assert.equal(manifest.counts.failed, 1);

    const bodyHtml = fs.readFileSync(path.join(dir, "body.html"), "utf8");
    assert.match(bodyHtml, /Re the \{\{role\}\} role/, "the raw composed body is archived");
    assert.ok(fs.existsSync(path.join(dir, "body.txt")), "plain-text body written");

    const csv = fs.readFileSync(path.join(dir, "recipients.csv"), "utf8");
    assert.match(csv, /priya@acme\.com/, "recipient email listed in the CSV");
    const priyaRow = csv.split("\n").find((line) => line.includes("priya@acme.com"));
    assert.match(priyaRow, /sent/, "Priya's row records a 'sent' status");
  });

  await t.test("a real send is refused while SMTP details are missing from the payload", async () => {
    const res = await post("/api/send", { ...message, recipients: [], dryRun: false });
    assert.equal(res.status, 400);
  });

  await t.test("daily cap blocks an oversized run until forced", async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ email: `x${i}@acme.com`, name: "", company: "", role: "" }));
    const res = await post("/api/send", { ...message, recipients: many, throttleMs: 0, campaign: "cap", dryRun: false });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, "daily_cap");
  });

  await t.test("abort stops a run partway through", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ email: `slow${i}@acme.com`, name: "", company: "", role: "" }));
    const job = await (
      await post("/api/send", { ...message, recipients: many, throttleMs: 400, campaign: "abort-test", dryRun: false })
    ).json();

    setTimeout(() => fetch(`${base}/api/send/${job.jobId}/abort`, { method: "POST" }), 700);
    const events = await collectStream(`${base}/api/send/${job.jobId}/stream`);
    const done = events.at(-1);

    assert.equal(done.aborted, true);
    assert.ok(done.skipped > 0, "some recipients were left unattempted");
    assert.ok(done.sent < 12, "the run stopped early");
  });
});
