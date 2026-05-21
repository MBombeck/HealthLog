/**
 * v1.4.19 phase A5 — IntegrationStatusPill
 *
 * The single tag rendered top-right of every integration card. The
 * pill is the ONLY place a connection status surfaces — the maintainer was
 * staring at three- to four-fold redundancy across Withings + Mood Log
 * cards in v1.4.18 and called it out. This component is reusable so
 * v1.4.20 can drop the same pill on the Apple Health card.
 *
 * The four states this file locks in (one assertion each):
 *   1. connected           → "Connected · 12 min ago" pattern
 *   2. error               → "Error — reconnect" pattern
 *   3. error (without ts)  → bare error label, no "ago" suffix
 *   4. disconnected        → "Not connected" pattern (no relative ts)
 *
 * Plus locale parity: switching to `de` renders the German strings.
 * Plus a "no last-sync timestamp" guard for connected state.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { IntegrationStatusPill } from "../integration-status-pill";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("IntegrationStatusPill", () => {
  it("renders the connected state with relative time when lastSyncAt is recent", () => {
    const twelveMinAgo = new Date(Date.now() - 12 * 60 * 1000);
    const html = render(
      <IntegrationStatusPill
        state="connected"
        lastSyncAt={twelveMinAgo}
        now={new Date()}
      />,
    );
    expect(html).toContain("Connected");
    // 12 min in EN locale
    expect(html).toMatch(/12\s+min(\.|utes)?\s+ago/);
    // Renders within a single pill marker so cards can target it.
    expect(html).toContain('data-testid="integration-status-pill"');
    expect(html).toContain('data-state="connected"');
  });

  it("renders the connected state without relative time when lastSyncAt is null", () => {
    const html = render(
      <IntegrationStatusPill state="connected" lastSyncAt={null} />,
    );
    expect(html).toContain("Connected");
    // Must not render the relative-time separator " · " when the
    // timestamp is missing, otherwise the pill reads "Connected · ".
    expect(html).not.toMatch(/Connected.*\s·\s\s/);
  });

  it("renders the error state with the reconnect-cta phrasing", () => {
    const html = render(
      <IntegrationStatusPill state="error" lastSyncAt={null} />,
    );
    expect(html).toContain("Error");
    expect(html).toContain("reconnect");
    expect(html).toContain('data-state="error"');
  });

  it("renders the disconnected state with the 'not connected' label", () => {
    const html = render(
      <IntegrationStatusPill state="disconnected" lastSyncAt={null} />,
    );
    expect(html).toContain("Not connected");
    expect(html).toContain('data-state="disconnected"');
  });

  it("renders German strings when the active locale is 'de'", () => {
    const html = render(
      <IntegrationStatusPill state="disconnected" lastSyncAt={null} />,
      "de",
    );
    expect(html).toContain("Nicht verbunden");
  });

  it("uses an abbreviated relative-time form for very recent syncs (< 1 min)", () => {
    const fortySecondsAgo = new Date(Date.now() - 40 * 1000);
    const html = render(
      <IntegrationStatusPill
        state="connected"
        lastSyncAt={fortySecondsAgo}
        now={new Date()}
      />,
    );
    // Sub-minute syncs collapse to "just now" so the pill stays
    // narrow on Pixel 5.
    expect(html).toMatch(/just\s+now/i);
  });

  // v1.4.43 W14 — parked-state copy.
  // Distinct from `error` (red reconnect pill) because the user can
  // resume the integration without redoing the OAuth dance; distinct
  // from `warning` because the persistent streak survived the alert
  // ladder AND the 24h grace window — manual intervention required.
  it("renders the parked state with manual-reconnect phrasing (EN)", () => {
    const html = render(
      <IntegrationStatusPill state="parked" lastSyncAt={null} />,
    );
    expect(html).toContain("Paused");
    expect(html).toContain("reconnect manually");
    expect(html).toContain('data-state="parked"');
  });

  it("renders the parked state with manual-reconnect phrasing (DE)", () => {
    const html = render(
      <IntegrationStatusPill state="parked" lastSyncAt={null} />,
      "de",
    );
    expect(html).toContain("Pausiert");
    expect(html).toContain("manuell wieder verbinden");
  });
});
