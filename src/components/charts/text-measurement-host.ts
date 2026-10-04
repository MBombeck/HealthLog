/**
 * Where Recharts measures text, moved out of `<body>`.
 *
 * Recharts sizes every axis tick and label by writing the string into one
 * shared, off-screen `<span id="recharts_measurement_span">` and reading its
 * `getBoundingClientRect()`. It looks the span up by id and creates it under
 * `<body>` only when it is missing, so whichever element carries that id is
 * the one it uses.
 *
 * Under `<body>` each of those reads cost a document-wide style recalc. The
 * stylesheet carries `:has()` rules whose subject is any descendant of an
 * anchor (`:is(:where(.group/avatar-group):has(…) *)`, the card and dialog
 * slot rules), so Chromium cannot scope the invalidation a text change in a
 * `<body>` descendant causes. Measured on a seeded dashboard: 149 reads per
 * cold load, about 2.8 ms each unthrottled (about 1.8 s of the 2.5 s of
 * blocking time under a 4x CPU slowdown). The same read on a span outside
 * `<body>`, inside a `contain: strict` box, costs about 0.01 ms.
 *
 * So the span lives under `<html>`, next to `<body>`, inside a zero-size
 * contained host. The host copies `<body>`'s class list, which is where the
 * app font is set (`--font-sans` + `font-sans`), so every string measures in
 * the same font at the same size as before and the charts lay out exactly as
 * they did.
 */

export const RECHARTS_MEASUREMENT_SPAN_ID = "recharts_measurement_span";

const HOST_STYLE = [
  "position:absolute",
  "top:0",
  "left:0",
  "width:0",
  "height:0",
  "overflow:hidden",
  "contain:strict",
  "visibility:hidden",
  "pointer-events:none",
].join(";");

/**
 * Put the measurement span into its contained host under `<html>`. Moves a
 * span Recharts already created under `<body>`; a no-op once installed.
 * Returns the span, or `null` where there is no DOM.
 */
export function installTextMeasurementHost(
  doc: Document | undefined = typeof document === "undefined"
    ? undefined
    : document,
): HTMLElement | null {
  if (!doc?.documentElement || !doc.body) return null;
  const existing = doc.getElementById(RECHARTS_MEASUREMENT_SPAN_ID);
  const parent = existing?.parentElement;
  if (
    existing &&
    parent?.dataset.slot === "chart-text-measurement-host" &&
    parent.parentElement === doc.documentElement
  ) {
    return existing;
  }

  const host = doc.createElement("div");
  host.dataset.slot = "chart-text-measurement-host";
  host.setAttribute("aria-hidden", "true");
  host.className = doc.body.className;
  host.style.cssText = HOST_STYLE;

  const span = existing ?? doc.createElement("span");
  span.id = RECHARTS_MEASUREMENT_SPAN_ID;
  span.setAttribute("aria-hidden", "true");
  host.appendChild(span);
  doc.documentElement.appendChild(host);
  return span;
}
