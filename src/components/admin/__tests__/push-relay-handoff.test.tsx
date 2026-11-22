/**
 * The hand-off time on the relay card: the two percentiles in a unit a
 * person reads at a glance, the number of pushes behind them, the retries
 * only when there were some, and a plain sentence instead of figures when
 * the window holds no accepted push.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import deMessages from "../../../../messages/de.json";
import { I18nProvider } from "@/lib/i18n/context";
import { PushRelayHandoff } from "../push-relay-handoff";

type Handoff = Parameters<typeof PushRelayHandoff>[0]["handoff"];

const MEASURED: Handoff = {
  windowHours: 24,
  count: 1234,
  p50Ms: 180,
  p95Ms: 1240,
  retried: 3,
};

const NOTHING: Handoff = {
  windowHours: 24,
  count: 0,
  p50Ms: null,
  p95Ms: null,
  retried: 0,
};

function render(handoff: Handoff, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider
      initialLocale={locale}
      initialMessages={locale === "de" ? deMessages : undefined}
    >
      <PushRelayHandoff handoff={handoff} />
    </I18nProvider>,
  );
}

/** The label and value pairs of the figures, in order. */
function figures(html: string): Array<[string, string]> {
  return [
    ...html.matchAll(/<dt[^>]*>([^<]*)<\/dt><dd[^>]*>([^<]*)<\/dd>/g),
  ].map((m) => [m[1]!, m[2]!]);
}

describe("<PushRelayHandoff>", () => {
  it("shows the median, the 95th percentile, the pushes and the retries", () => {
    const html = render(MEASURED);
    expect(html).toContain("Hand-off time, last 24 h");
    expect(figures(html)).toEqual([
      ["Median", "180 ms"],
      ["95th percentile", "1.2 s"],
      ["Pushes", "1,234"],
      ["Needed a retry", "3"],
    ]);
    expect(html).toContain(
      "From queueing on this server to the relay&#x27;s answer. The relay answers once Apple has accepted the push.",
    );
  });

  it("leaves the retries out when no push needed one", () => {
    const html = render({ ...MEASURED, retried: 0 });
    expect(figures(html).map(([label]) => label)).toEqual([
      "Median",
      "95th percentile",
      "Pushes",
    ]);
  });

  it("switches from milliseconds to seconds at one second", () => {
    const at = (p50Ms: number, p95Ms: number) =>
      figures(render({ ...MEASURED, p50Ms, p95Ms }))
        .slice(0, 2)
        .map(([, value]) => value);
    expect(at(0, 999)).toEqual(["0 ms", "999 ms"]);
    expect(at(1000, 1049)).toEqual(["1.0 s", "1.0 s"]);
    expect(at(1050, 480_080)).toEqual(["1.1 s", "480.1 s"]);
  });

  it("says that the window holds no push instead of showing figures", () => {
    const html = render(NOTHING);
    expect(html).toContain("Hand-off time, last 24 h");
    expect(html).toContain("<p>No pushes in the last 24 hours</p>");
    expect(figures(html)).toEqual([]);
    expect(html).not.toContain("<dl");
    // What it measures stays on the card either way.
    expect(html).toContain("From queueing on this server");
  });

  it("follows the window the server reports", () => {
    const html = render({ ...NOTHING, windowHours: 1 });
    expect(html).toContain("Hand-off time, last 1 h");
    expect(html).toContain("<p>No pushes in the last 1 hour</p>");
  });

  it("prints the figures in the reader's notation", () => {
    const html = render(MEASURED, "de");
    expect(html).toContain("Übergabezeit, letzte 24 h");
    expect(figures(html)).toEqual([
      ["Median", "180 ms"],
      ["95. Perzentil", "1,2 s"],
      ["Pushes", "1.234"],
      ["Erneut versucht", "3"],
    ]);
    expect(render(NOTHING, "de")).toContain(
      "Keine Pushes in den letzten 24 Stunden",
    );
  });
});
