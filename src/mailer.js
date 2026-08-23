import fs from "node:fs";
import path from "node:path";
import { createTransport } from "nodemailer";
import { config, isConfigured, ATTACHMENTS_DIR } from "./config.js";

let transport = null;

export function getTransport() {
  if (!isConfigured) throw new Error("SMTP is not configured — add SMTP_USER and SMTP_PASS to mailer/.env");
  if (!transport) {
    transport = createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
      // One connection, sequential sends: bulk parallelism is what trips Gmail's limits.
      pool: true,
      maxConnections: 1,
      maxMessages: 100,
    });
  }
  return transport;
}

export function closeTransport() {
  if (transport) {
    transport.close();
    transport = null;
  }
}

/** Pre-flight credential check, so a bad App Password fails before recipient #1. */
export async function verifyTransport() {
  await getTransport().verify();
  return true;
}

export function listAttachments() {
  try {
    return fs
      .readdirSync(ATTACHMENTS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
      .map((entry) => {
        const full = path.join(ATTACHMENTS_DIR, entry.name);
        return { name: entry.name, size: fs.statSync(full).size };
      });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

/** Resolves UI-selected filenames to nodemailer attachments, refusing anything outside attachments/. */
export function resolveAttachments(names = []) {
  return names.map((raw) => {
    const name = path.basename(String(raw));
    const full = path.join(ATTACHMENTS_DIR, name);
    if (!fs.existsSync(full)) throw new Error(`Attachment not found: ${name}`);
    return { filename: name, path: full };
  });
}

export function fromAddress() {
  return config.fromName ? `"${config.fromName.replace(/"/g, "")}" <${config.smtp.user}>` : config.smtp.user;
}

export async function sendOne({ to, subject, html, text, attachments = [] }) {
  const info = await getTransport().sendMail({
    from: fromAddress(),
    to, // one recipient per message — never CC/BCC-bundled
    replyTo: config.replyTo || undefined,
    subject,
    text,
    html,
    attachments,
  });
  return info.messageId;
}
