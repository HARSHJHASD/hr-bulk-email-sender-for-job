import fs from "node:fs";
import { SUPPRESSION_FILE } from "./config.js";
import { sentKeys } from "./ledger.js";

const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[A-Za-z]{2,}$/;

/**
 * Tokenizer for pasted lists and uploaded CSVs. Handles quoted fields (company names
 * contain commas), escaped quotes, and comma / semicolon / tab delimiters, so no CSV
 * dependency is needed.
 */
function parseDelimited(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    if (row.some((cell) => cell.trim())) rows.push(row.map((cell) => cell.trim()));
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.trim() === "") {
      inQuotes = true;
      field = "";
      continue;
    }
    if (ch === "," || ch === ";" || ch === "\t") {
      pushField();
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      pushRow();
      continue;
    }
    field += ch;
  }
  pushRow();
  return rows;
}

/** Pulls the address out of `Priya Sharma <priya@acme.com>` as well as a bare address. */
function extractEmail(cell) {
  const angled = cell.match(/<([^<>]+)>/);
  const candidate = (angled ? angled[1] : cell).trim();
  return EMAIL_RE.test(candidate) ? candidate : null;
}

function displayName(cell) {
  const angled = cell.match(/^([^<>]+)<[^<>]+>$/);
  return angled ? angled[1].trim().replace(/^["']|["']$/g, "") : "";
}

const HEADER_ALIASES = {
  email: ["email", "e-mail", "emailaddress", "mail", "emailid", "hremail"],
  name: ["name", "hrname", "contact", "contactname", "firstname", "recruiter", "person"],
  company: ["company", "organisation", "organization", "org", "employer", "companyname"],
  role: ["role", "position", "job", "title", "jobtitle", "opening", "designation"],
};

function detectHeader(cells) {
  const hasEmailValue = cells.some((cell) => extractEmail(cell));
  if (hasEmailValue) return null;
  const norm = cells.map((cell) => cell.toLowerCase().replace(/[^a-z]/g, ""));
  if (!norm.some((cell) => HEADER_ALIASES.email.includes(cell))) return null;

  const map = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const index = norm.findIndex((cell) => aliases.includes(cell));
    if (index !== -1) map[field] = index;
  }
  return map;
}

function fromMappedRow(cells, map) {
  const raw = cells[map.email] ?? "";
  const email = extractEmail(raw);
  return {
    email,
    name: (map.name !== undefined ? cells[map.name] : "") || displayName(raw) || "",
    company: (map.company !== undefined ? cells[map.company] : "") || "",
    role: (map.role !== undefined ? cells[map.role] : "") || "",
  };
}

/** Positional fallback: `email, name, company, role` in any column order. */
function fromPositionalRow(cells) {
  const emailIndexes = cells.map((cell, i) => (extractEmail(cell) ? i : -1)).filter((i) => i !== -1);

  // A line that is nothing but addresses is a plain list, not one personalized row.
  if (emailIndexes.length > 1) {
    return emailIndexes.map((i) => ({
      email: extractEmail(cells[i]),
      name: displayName(cells[i]),
      company: "",
      role: "",
    }));
  }
  if (emailIndexes.length === 0) return [];

  const emailCell = cells[emailIndexes[0]];
  const rest = cells.filter((_, i) => i !== emailIndexes[0]).filter((cell) => cell);
  return [
    {
      email: extractEmail(emailCell),
      name: rest[0] || displayName(emailCell) || "",
      company: rest[1] || "",
      role: rest[2] || "",
    },
  ];
}

export function readSuppression() {
  try {
    return new Set(
      fs
        .readFileSync(SUPPRESSION_FILE, "utf8")
        .split("\n")
        .map((line) => line.split("#")[0].trim().toLowerCase())
        .filter(Boolean)
    );
  } catch (err) {
    if (err.code === "ENOENT") return new Set();
    throw err;
  }
}

/**
 * Turns raw pasted text or CSV contents into a clean recipient list plus a report of
 * everything that was dropped and why, so nothing disappears silently.
 */
export function parseRecipients(text, { campaign = "" } = {}) {
  const rows = parseDelimited(String(text || ""));
  const report = { totalRows: 0, invalid: [], duplicates: [], suppressed: [], alreadySent: [] };
  if (rows.length === 0) return { recipients: [], report };

  const header = detectHeader(rows[0]);
  const bodyRows = header ? rows.slice(1) : rows;
  report.totalRows = bodyRows.length;

  const suppression = readSuppression();
  const sent = sentKeys();
  const seen = new Set();
  const recipients = [];

  for (const cells of bodyRows) {
    const candidates = header ? [fromMappedRow(cells, header)] : fromPositionalRow(cells);

    if (candidates.length === 0 || candidates.every((c) => !c.email)) {
      report.invalid.push(cells.join(", "));
      continue;
    }

    for (const candidate of candidates) {
      if (!candidate.email) {
        report.invalid.push(cells.join(", "));
        continue;
      }
      const lower = candidate.email.toLowerCase();
      if (seen.has(lower)) {
        report.duplicates.push(candidate.email);
        continue;
      }
      seen.add(lower);
      if (suppression.has(lower)) {
        report.suppressed.push(candidate.email);
        continue;
      }
      if (sent.has(`${lower}::${String(campaign).trim().toLowerCase()}`)) {
        report.alreadySent.push(candidate.email);
        continue;
      }
      recipients.push({
        email: candidate.email,
        name: candidate.name || "",
        company: candidate.company || "",
        role: candidate.role || "",
      });
    }
  }

  return { recipients, report };
}

export { EMAIL_RE };
