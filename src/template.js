/** Merge-field rendering: `{{name}}`, or `{{name|custom fallback}}` when the column is blank. */

const BUILTIN_FALLBACKS = {
  name: "there",
  company: "your company",
  role: "the role",
};

export const MERGE_FIELDS = Object.keys(BUILTIN_FALLBACKS);

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * @param {string} template  text containing {{field}} / {{field|fallback}}
 * @param {object} recipient { email, name, company, role }
 * @param {boolean} escape   true for HTML output, false for plain text / subject lines
 */
export function render(template, recipient, { escape = true } = {}) {
  return String(template || "").replace(/\{\{\s*([a-zA-Z_]+)\s*(?:\|([^}]*))?\}\}/g, (match, rawField, rawFallback) => {
    const field = rawField.toLowerCase();
    const value = String(recipient?.[field] ?? "").trim();
    if (value) return escape ? escapeHtml(value) : value;

    const fallback = rawFallback !== undefined ? rawFallback.trim() : BUILTIN_FALLBACKS[field];
    if (fallback === undefined) return match; // unknown field: leave visible rather than blanking it
    return escape ? escapeHtml(fallback) : fallback;
  });
}

/**
 * Derives the plain-text alternative from the HTML body. Sending an HTML-only message
 * measurably hurts deliverability, and hand-maintaining two bodies goes stale.
 */
export function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => {
      const text = label.replace(/<[^>]+>/g, "").trim();
      return !text || text === href ? href : `${text} (${href})`;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li|blockquote)>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Builds the exact subject / html / text a given recipient will receive. */
export function renderMessage({ subject, bodyHtml }, recipient) {
  const html = render(bodyHtml, recipient, { escape: true });
  return {
    subject: render(subject, recipient, { escape: false }),
    html,
    text: htmlToText(html),
  };
}
