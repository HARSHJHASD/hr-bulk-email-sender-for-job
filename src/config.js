import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ATTACHMENTS_DIR = process.env.ATTACHMENTS_DIR
  ? path.resolve(process.env.ATTACHMENTS_DIR)
  : path.join(ROOT, "attachments");
// Overridable so the test suite never touches the real ledger or suppression list.
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
export const TEMPLATES_DIR = path.join(ROOT, "templates");
export const LEDGER_FILE = path.join(DATA_DIR, "sent-log.jsonl");
export const SUPPRESSION_FILE = path.join(DATA_DIR, "suppression.txt");
// One folder per real send: subject + body + attachment names + recipient list.
export const CAMPAIGNS_DIR = path.join(DATA_DIR, "campaigns");

const num = (value, fallback) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  smtp: {
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: num(process.env.SMTP_PORT, 465),
    user: process.env.SMTP_USER || "",
    // Gmail App Passwords are shown in groups of four; people paste the spaces too.
    pass: (process.env.SMTP_PASS || "").replace(/\s+/g, ""),
  },
  fromName: process.env.FROM_NAME || "",
  replyTo: process.env.REPLY_TO || process.env.SMTP_USER || "",
  throttleMs: num(process.env.THROTTLE_MS, 2000),
  dailyCap: num(process.env.DAILY_CAP, 500),
  port: num(process.env.PORT, 8787),
};

/** False until an App Password is present, which puts the dashboard in dry-run-only mode. */
export const isConfigured = Boolean(config.smtp.user && config.smtp.pass);

export function missingEnv() {
  const missing = [];
  if (!config.smtp.user) missing.push("SMTP_USER");
  if (!config.smtp.pass) missing.push("SMTP_PASS");
  return missing;
}
