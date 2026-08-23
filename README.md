# HR Mail Blaster

A local dashboard that sends one personalized email — subject, HTML body, attachment — to
every HR contact in a list you paste in. Each recipient gets their **own separate message**;
nobody is CC'd or BCC'd together.

It runs entirely on your machine, bound to `127.0.0.1`, because the process holds your SMTP
credentials. Nothing is deployed, and it is completely separate from the portfolio app — the
Vite build never touches this folder.

---

## What you need to do (one time, ~3 minutes)

Everything else is already built and tested. This is the only part I can't do for you,
because it needs your Google account.

### 1. Turn on 2-Step Verification

App Passwords don't exist without it: https://myaccount.google.com/security

### 2. Generate a Gmail App Password

Go to **https://myaccount.google.com/apppasswords**, type any name (e.g. `mail blaster`),
and click Create. You'll get a 16-character code like `abcd efgh ijkl mnop`.

This is **not** your Google password. It only permits sending mail, and you can revoke it
any time from that same page.

### 3. Create `mailer/.env`

Copy the example and paste the code in:

```bash
cp mailer/.env.example mailer/.env
```

Then open `mailer/.env` and set `SMTP_PASS` to the 16-character code. Spaces are fine —
they get stripped. Double-check `SMTP_USER` is the Gmail address you want to send from.

`.env` is gitignored, so the password never lands in the repo.

### 4. Start it

```bash
npm --prefix mailer start
```

Open **http://localhost:8787**. The pill in the top right should read **smtp ready**.
If it says *dry run only*, `.env` isn't filled in yet.

### 5. Send one to yourself first

Put your own address in the recipients box, run a **Dry run**, then **Send to 1**. Confirm it
lands and that `resume.pdf` opens. Only then paste the real HR list.

---

## Using it

**1 — Recipients.** Paste one per line: `email, name, company, role`. Only the email is
required. All of these work:

```
priya@acme.com, Priya Sharma, Acme Corp, SDE-1
hr@globex.com, , Globex, Frontend Engineer
Rahul Verma <rahul@initech.com>
recruiting@initech.com
```

A header row is detected automatically, and columns are matched by name in any order, so
you can paste a CSV exported from a spreadsheet as-is:

```
Company,Email,Position,Name
Acme,priya@acme.com,SDE-1,Priya
```

Quoted fields are handled, so `"Globex, Inc."` stays one company.

Set a **campaign name** (e.g. `sde-outreach-aug`). It's what the duplicate guard keys on:
the same address is never mailed twice within one campaign, but a later campaign to the same
person is allowed.

**2 — Message.** `Load starter template` fills in a working outreach email. The body is HTML
and the right-hand preview is exactly what the recipient sees. Merge fields:

| Field | Fills from | If blank |
| --- | --- | --- |
| `{{name}}` | name column | `there` |
| `{{company}}` | company column | `your company` |
| `{{role}}` | role column | `the role` |
| `{{name\|Hiring Team}}` | name column | your own text after the `\|` |

Merge fields work in the subject line too.

**3 — Attachment.** Files in `mailer/attachments/` appear as checkboxes; `resume.pdf` is
already there and pre-ticked. You can also upload from the dashboard.

**4 — Review & send.** `Dry run preview` renders every recipient's message and streams the
full log without touching SMTP. The **Send** button stays locked until you've done this, and
re-locks if you edit anything afterwards.

---

## The safety rails

These exist because a bulk-send mistake is not undoable.

- **Dry run required.** Send is disabled until a dry run has been done on the current content.
- **Separate messages.** One SMTP transaction, one recipient. HR never sees other recipients.
- **Throttled.** Default one mail per ~5s with ±30% jitter, so the pattern doesn't look robotic.
- **Ledger.** Every attempt is appended to `mailer/data/sent-log.jsonl`. Re-running a campaign
  skips everyone already sent to, so a double-click can't double-mail. Failures stay retryable.
- **Daily cap.** Blocks at 500/day (Gmail's limit) unless you explicitly override. The header
  shows today's count.
- **Suppression list.** Addresses in `mailer/data/suppression.txt` are always skipped.
- **Nothing dropped silently.** Invalid, duplicate, suppressed and already-mailed addresses are
  each counted and listed; hover the chip to see which.
- **Abort.** Stops after the in-flight message; the rest are reported as not attempted.
- **Failures export.** Download the failed rows as CSV and paste them straight back in to retry.
- **Localhost only.** The server refuses connections from other machines.

---

## Tests

```bash
npm --prefix mailer test
```

25 tests. The integration suite boots the real server against a **fake SMTP server** and
asserts the actual bytes on the wire — that the attachment is present, that the body is
multipart HTML + plain text, that each message carries exactly one recipient, that a rejected
address is recorded without killing the run, and that the ledger, daily cap and abort all
behave. No live mailbox needed.

---

## Deliverability notes

Cold outreach from a personal Gmail is fine at this volume, but:

- Keep it under a few hundred a day. The 500 cap is a hard Google limit, not a suggestion.
- Personalize properly — `{{company}}` and `{{role}}` filled in from real data reads very
  differently from an obvious blast, both to a human and to a spam filter.
- Every message goes out as HTML **plus** a plain-text alternative, which is derived from your
  HTML automatically. HTML-only mail scores worse.
- Avoid ALL CAPS subjects, `!!!`, and link shorteners.
- Replies come to `REPLY_TO`, i.e. your normal inbox.

Gmail SMTP cannot report opens, clicks, or bounces — a bounce arrives as a normal email in
your inbox. If you later want real tracking you'd need a provider like Resend with your own
domain; the transport is isolated in `src/mailer.js`, so that swap is contained.

---

## Layout

```
mailer/
  server.js              HTTP routes, SSE progress stream, localhost bind
  src/config.js          env parsing, defaults, isConfigured flag
  src/recipients.js      list/CSV parsing, validation, dedupe, suppression
  src/template.js        {{merge}} rendering, HTML → plain text
  src/mailer.js          nodemailer transport, verify, sendOne
  src/ledger.js          append-only send history + duplicate guard
  src/job.js             send loop: throttle, retry, abort, progress events
  public/                dashboard (no build step)
  templates/outreach.html starter email
  attachments/           files you can attach
  data/                  sent-log.jsonl, suppression.txt
  test/                  unit + end-to-end suites
```
