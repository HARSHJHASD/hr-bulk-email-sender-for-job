import fs from "node:fs";
import { LEDGER_FILE, DATA_DIR } from "./config.js";

/**
 * Append-only record of every send attempt, one JSON object per line.
 * Keyed on email + campaign so a *different* campaign to the same HR is allowed,
 * while an accidental re-run of the same one is blocked.
 */

const key = (email, campaign) => `${String(email).trim().toLowerCase()}::${String(campaign || "").trim().toLowerCase()}`;

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function readLedger() {
  try {
    return fs
      .readFileSync(LEDGER_FILE, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null; // tolerate a torn final line rather than losing the whole ledger
        }
      })
      .filter(Boolean);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

export function appendLedger(entry) {
  ensureDir();
  fs.appendFileSync(LEDGER_FILE, `${JSON.stringify(entry)}\n`, "utf8");
}

/** Set of `email::campaign` keys that already went out successfully. */
export function sentKeys() {
  const keys = new Set();
  for (const entry of readLedger()) {
    if (entry.status === "sent") keys.add(key(entry.email, entry.campaign));
  }
  return keys;
}

export function alreadySent(email, campaign) {
  return sentKeys().has(key(email, campaign));
}

/** Successful sends today, for the Gmail daily-cap warning. */
export function sentToday() {
  const today = new Date().toISOString().slice(0, 10);
  return readLedger().filter((e) => e.status === "sent" && String(e.timestamp || "").startsWith(today)).length;
}

export function ledgerStats() {
  const entries = readLedger();
  return {
    total: entries.length,
    sent: entries.filter((e) => e.status === "sent").length,
    failed: entries.filter((e) => e.status === "failed").length,
    today: sentToday(),
    campaigns: [...new Set(entries.map((e) => e.campaign).filter(Boolean))],
  };
}
