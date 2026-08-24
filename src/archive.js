import fs from "node:fs";
import path from "node:path";
import { CAMPAIGNS_DIR, ATTACHMENTS_DIR } from "./config.js";
import { htmlToText } from "./template.js";

/** Campaign name → filename-safe slug. Empty/whitespace becomes "no-campaign". */
export function slugify(campaign) {
  const slug = String(campaign || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, ""); // a trailing dash can reappear after the slice
  return slug || "no-campaign";
}

/** ISO timestamp → `2026-08-24_14-30-05`, safe for a Windows folder name (no colons). */
export function stamp(iso) {
  return String(iso).replace(/\.\d+Z$/, "").replace("T", "_").replace(/:/g, "-");
}

/** CSV cell: wrap in quotes and double any internal quotes, since names/companies contain commas. */
const csvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;

/** Attachment names → [{ name, size }], size null if the file is gone by archive time. */
function attachmentDetails(names = []) {
  return names.map((raw) => {
    const name = path.basename(String(raw));
    try {
      return { name, size: fs.statSync(path.join(ATTACHMENTS_DIR, name)).size };
    } catch {
      return { name, size: null };
    }
  });
}

/**
 * Writes one self-contained folder recording exactly what a send delivered:
 * manifest.json, body.html, body.txt, recipients.csv. Best-effort — any failure is logged
 * and swallowed so archiving can never break or abort a send. Returns the dir path, or null.
 */
export function writeRunArchive({
  jobId,
  campaign = "",
  subject,
  bodyHtml,
  attachments = [],
  recipients = [],
  outcomeByIndex = new Map(),
  throttleMs,
  startedAt,
  finishedAt,
  counts = {},
  aborted = false,
}) {
  try {
    const shortId = String(jobId || "").slice(0, 8) || "run";
    const dirName = `${stamp(startedAt)}__${slugify(campaign)}__${shortId}`;
    const dir = path.join(CAMPAIGNS_DIR, dirName);
    fs.mkdirSync(dir, { recursive: true });

    const attachmentInfo = attachmentDetails(attachments);

    const results = recipients.map((recipient, i) => {
      const outcome = outcomeByIndex.get(i) || { status: "skipped", messageId: null, error: null };
      return {
        email: recipient.email,
        name: recipient.name || "",
        company: recipient.company || "",
        role: recipient.role || "",
        status: outcome.status,
        messageId: outcome.messageId || null,
        error: outcome.error || null,
      };
    });

    const manifest = {
      jobId,
      campaign,
      subject,
      attachments: attachmentInfo,
      throttleMs,
      startedAt,
      finishedAt,
      aborted,
      counts,
      recipients: results,
    };

    fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(dir, "body.html"), String(bodyHtml || ""), "utf8");
    fs.writeFileSync(path.join(dir, "body.txt"), htmlToText(bodyHtml), "utf8");

    const header = ["email", "name", "company", "role", "status", "messageId"];
    const rows = results.map((r) => [r.email, r.name, r.company, r.role, r.status, r.messageId].map(csvCell).join(","));
    fs.writeFileSync(path.join(dir, "recipients.csv"), `${header.join(",")}\n${rows.join("\n")}\n`, "utf8");

    return dir;
  } catch (err) {
    console.error("Failed to write campaign archive:", err.message);
    return null;
  }
}
