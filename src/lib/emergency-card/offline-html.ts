/**
 * The emergency card as one self-contained HTML file (v1.49): the offline
 * copy the owner saves to their phone.
 *
 * The app's own pages never work without a connection on purpose: a
 * signed-in page is never cached, so a lost phone does not hand out a
 * record (`public/sw.js`). The card is the one thing worth carrying offline,
 * so it leaves as a file the owner chooses to keep: inline styles, no
 * script, no external request, every value HTML-escaped. It opens from the
 * Files app or a home-screen bookmark with no network, and it holds what it
 * held on the day it was saved, which the file says.
 */
import type { EmergencyCardView } from "./card-data";
import { emergencyCardRows, formatCardDay, type Translate } from "./rows";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const STYLE =
  ":root{color-scheme:light dark;--bg:#ffffff;--fg:#1f2030;--muted:#5b5e78;--line:#d9d9e3;--accent:#b4231e}" +
  "@media (prefers-color-scheme:dark){:root{--bg:#1f2030;--fg:#f8f8f2;--muted:#a4a9c9;--line:#3a3c4e;--accent:#ff8a80}}" +
  "body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,sans-serif}" +
  "main{max-width:36rem;margin:0 auto;padding:16px}" +
  "h1{margin:0 0 4px;font-size:1.5rem;color:var(--accent)}" +
  "p{margin:0 0 12px;color:var(--muted);font-size:.875rem}" +
  "dl{margin:0}div.row{padding:12px 0;border-top:1px solid var(--line)}" +
  "dt{font-size:.75rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}" +
  "dd{margin:4px 0 0;overflow-wrap:anywhere;white-space:pre-line}dd.strong{font-weight:700;font-size:1.0625rem}";

export function buildOfflineCardHtml(
  view: EmergencyCardView,
  t: Translate,
  locale: string,
): string {
  const rows = emergencyCardRows(view, t, locale)
    .map(
      (row) =>
        `<div class="row"><dt>${escapeHtml(row.label)}</dt>${row.lines
          .map(
            (line) =>
              `<dd${row.emphasise ? ' class="strong"' : ""}>${escapeHtml(line)}</dd>`,
          )
          .join("")}</div>`,
    )
    .join("");
  const lang = escapeHtml(locale);
  return (
    `<!DOCTYPE html><html lang="${lang}"><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<meta name="robots" content="noindex,nofollow">' +
    `<title>${escapeHtml(t("emergencyCard.title"))}</title><style>${STYLE}</style></head>` +
    `<body><main><h1>${escapeHtml(t("emergencyCard.title"))}</h1>` +
    `<p>${escapeHtml(t("emergencyCard.subtitle"))}</p>` +
    `<p>${escapeHtml(t("emergencyCard.savedOn", { date: formatCardDay(locale, view.asOf) }))}</p>` +
    `<dl>${rows}</dl></main></body></html>`
  );
}
