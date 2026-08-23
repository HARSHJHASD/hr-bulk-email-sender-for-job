import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the ledger + suppression list at a throwaway dir BEFORE importing the modules.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blaster-unit-"));
process.env.DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, "suppression.txt"), "blocked@nope.com\n# a comment\n");

const { parseRecipients } = await import("../src/recipients.js");
const { render, htmlToText, renderMessage } = await import("../src/template.js");
const { appendLedger } = await import("../src/ledger.js");

test("parses positional rows: email, name, company, role", () => {
  const { recipients } = parseRecipients("priya@acme.com, Priya Sharma, Acme Corp, SDE-1");
  assert.deepEqual(recipients, [{ email: "priya@acme.com", name: "Priya Sharma", company: "Acme Corp", role: "SDE-1" }]);
});

test("respects quoted fields containing commas", () => {
  const { recipients } = parseRecipients('hr@globex.com, Rahul, "Globex, Inc.", Frontend Engineer');
  assert.equal(recipients[0].company, "Globex, Inc.");
  assert.equal(recipients[0].role, "Frontend Engineer");
});

test("extracts Name <email> form and uses the display name", () => {
  const { recipients } = parseRecipients("Rahul Verma <rahul@initech.com>");
  assert.equal(recipients[0].email, "rahul@initech.com");
  assert.equal(recipients[0].name, "Rahul Verma");
});

test("a line of only addresses becomes several recipients, not one row", () => {
  const { recipients } = parseRecipients("a@x.com, b@y.com, c@z.com");
  assert.deepEqual(
    recipients.map((r) => r.email),
    ["a@x.com", "b@y.com", "c@z.com"]
  );
});

test("detects a header row and maps columns by name, in any order", () => {
  const { recipients, report } = parseRecipients(
    ["Company,Email,Position,Name", "Acme,priya@acme.com,SDE-1,Priya"].join("\n")
  );
  assert.equal(report.totalRows, 1);
  assert.deepEqual(recipients, [{ email: "priya@acme.com", name: "Priya", company: "Acme", role: "SDE-1" }]);
});

test("reports invalid, duplicate and suppressed addresses instead of dropping them silently", () => {
  const { recipients, report } = parseRecipients(
    ["good@acme.com, Ann", "not-an-email", "good@acme.com, Ann again", "blocked@nope.com"].join("\n")
  );
  assert.deepEqual(
    recipients.map((r) => r.email),
    ["good@acme.com"]
  );
  assert.equal(report.invalid.length, 1);
  assert.equal(report.duplicates.length, 1);
  assert.equal(report.suppressed.length, 1);
});

test("dedupe is case-insensitive", () => {
  const { recipients, report } = parseRecipients("HR@Acme.com\nhr@acme.com");
  assert.equal(recipients.length, 1);
  assert.equal(report.duplicates.length, 1);
});

test("skips addresses already mailed in the same campaign, but not a different one", () => {
  appendLedger({ email: "done@acme.com", campaign: "aug", status: "sent", timestamp: new Date().toISOString() });

  const same = parseRecipients("done@acme.com", { campaign: "aug" });
  assert.equal(same.recipients.length, 0);
  assert.deepEqual(same.report.alreadySent, ["done@acme.com"]);

  const other = parseRecipients("done@acme.com", { campaign: "sept" });
  assert.equal(other.recipients.length, 1);
});

test("a failed attempt does not count as already-sent, so retries work", () => {
  appendLedger({ email: "flaky@acme.com", campaign: "aug", status: "failed", timestamp: new Date().toISOString() });
  const { recipients } = parseRecipients("flaky@acme.com", { campaign: "aug" });
  assert.equal(recipients.length, 1);
});

test("merge fields fill from the row, fall back when blank", () => {
  const row = { email: "a@b.com", name: "Priya", company: "", role: "" };
  assert.equal(render("Hi {{name}},", row), "Hi Priya,");
  assert.equal(render("Hi {{name|friend}},", { ...row, name: "" }), "Hi friend,");
  assert.equal(render("at {{company}}", row), "at your company"); // built-in fallback
  assert.equal(render("the {{role}}", row), "the the role");
});

test("merged values are HTML-escaped in the body but not in the subject", () => {
  const row = { name: "A & B <script>", company: "X" };
  assert.equal(render("Hi {{name}}", row, { escape: true }), "Hi A &amp; B &lt;script&gt;");
  assert.equal(render("Hi {{name}}", row, { escape: false }), "Hi A & B <script>");
});

test("unknown merge fields stay visible rather than silently blanking", () => {
  assert.equal(render("Hello {{salary}}", { name: "x" }), "Hello {{salary}}");
});

test("plain-text alternative is derived from the HTML, links included", () => {
  const text = htmlToText('<p>Hi</p><ul><li>One</li></ul><a href="https://x.com">my site</a>');
  assert.match(text, /Hi/);
  assert.match(text, /- One/);
  assert.match(text, /my site \(https:\/\/x\.com\)/);
  assert.doesNotMatch(text, /</);
});

test("renderMessage produces subject, html and text together", () => {
  const msg = renderMessage(
    { subject: "Application for {{role}} at {{company}}", bodyHtml: "<p>Hi {{name}},</p>" },
    { email: "p@acme.com", name: "Priya", company: "Acme", role: "SDE-1" }
  );
  assert.equal(msg.subject, "Application for SDE-1 at Acme");
  assert.equal(msg.html, "<p>Hi Priya,</p>");
  assert.equal(msg.text, "Hi Priya,");
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
