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
    expect(html).toContain("Paused: reconnect");
    expect(html).toContain('data-state="parked"');
  });

  it("renders the parked state with manual-reconnect phrasing (DE)", () => {
    const html = render(
      <IntegrationStatusPill state="parked" lastSyncAt={null} />,
      "de",
    );
    expect(html).toContain("Pausiert");
    expect(html).toContain("Pausiert: neu verbinden");
  });

  // The three states the server verdict added. `stale` and `stalled` both
  // carry an inline timestamp, because "since when" is the whole point of
  // them; `pending-setup` has nothing to timestamp yet.
  it("renders the stale state in the warning tone with its timestamp", () => {
    const html = render(
      <IntegrationStatusPill
        state="stale"
        lastSyncAt={new Date(Date.now() - 9 * 24 * 60 * 60 * 1000)}
        now={new Date()}
      />,
    );
    expect(html).toContain('data-state="stale"');
    expect(html).toContain("no recent data");
    expect(html).toMatch(/9\s+d\s+ago/);
    expect(html).toContain("bg-warning/15");
  });

  it("renders the stalled state as a stopped sync, not an error", () => {
    const html = render(
      <IntegrationStatusPill
        state="stalled"
        lastSyncAt={new Date(Date.now() - 28 * 24 * 60 * 60 * 1000)}
        now={new Date()}
      />,
    );
    expect(html).toContain('data-state="stalled"');
    expect(html).toContain("Sync stopped");
    expect(html).toMatch(/28\s+d\s+ago/);
    // Warning tone, never destructive: the user cannot fix a cron that
    // stopped by clicking reconnect.
    expect(html).toContain("bg-warning/15");
    expect(html).not.toContain('data-variant="destructive"');
  });

  it("renders the pending-setup state with no timestamp", () => {
    const html = render(
      <IntegrationStatusPill state="pending-setup" lastSyncAt={null} />,
    );
    expect(html).toContain('data-state="pending-setup"');
    expect(html).toContain("Waiting for first data");
    expect(html).not.toContain("bg-warning/15");
  });

  /**
   * Red is reserved for "your action fixes this". A transient upstream failure
   * is not that: telling the user to reconnect against a 503 sends them
   * clicking at something they cannot repair.
   */
  it("keeps the destructive variant for reauth alone", () => {
    expect(
      render(<IntegrationStatusPill state="error" lastSyncAt={null} />),
    ).toContain('data-variant="destructive"');
    for (const state of [
      "warning",
      "stale",
      "stalled",
      "parked",
      "pending-setup",
      "connected",
    ] as const) {
      expect(
        render(<IntegrationStatusPill state={state} lastSyncAt={null} />),
        state,
      ).not.toContain('data-variant="destructive"');
    }
  });

  it("lets a card keep its own established testid", () => {
    const html = render(
      <IntegrationStatusPill
        state="connected"
        lastSyncAt={null}
        testId="apple-health-status"
      />,
    );
    expect(html).toContain('data-testid="apple-health-status"');
  });
});

describe("IntegrationStatusPill — a failing provider states its age", () => {
  it("renders the failing state with how long it has been failing", () => {
    const seventeenDaysAgo = new Date(Date.now() - 17 * 24 * 60 * 60 * 1000);
    const html = render(
      <IntegrationStatusPill
        state="warning"
        lastSyncAt={seventeenDaysAgo}
        now={new Date()}
      />,
    );
    // The label must not open with a claim of connection: the pipe has
    // delivered nothing for a fortnight.
    expect(html).not.toContain("Connected");
    expect(html).toContain("Sync failing");
    // And the age has to be on the pill. Without it, hour one and day
    // seventeen render identically, which is how a dead sync stayed quiet.
    expect(html).toMatch(/17\s*d\s+ago/);
    expect(html).toContain('data-state="warning"');
  });

  it("renders the localized failure count against the server threshold", () => {
    const html = render(
      <IntegrationStatusPill
        state="warning"
        lastSyncAt={new Date()}
        now={new Date()}
        failureCount={2}
        failureThreshold={3}
      />,
    );

    expect(html).toContain("2/3");
  });

  it("omits a partial failure ratio", () => {
    const html = render(
      <IntegrationStatusPill
        state="warning"
        lastSyncAt={new Date()}
        now={new Date()}
        failureCount={2}
      />,
    );

    expect(html).not.toContain("2/");
  });

  it("keeps the German label free of a connection claim too", () => {
    const html = render(
      <IntegrationStatusPill
        state="warning"
        lastSyncAt={new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)}
        now={new Date()}
      />,
      "de",
    );
    expect(html).not.toContain("Verbunden");
    expect(html).toContain("Sync fehlgeschlagen");
  });
});

describe("IntegrationStatusPill — accessible name", () => {
  /**
   * A generic `aria-label` used to sit on the badge. Being a label, it
   * REPLACED the accessible name with itself, so a screen reader announced the
   * same words for a healthy connection as for a broken one — erasing the one
   * distinction the pill exists to draw.
   */
  it.each([
    ["connected", "Connected"],
    ["error", "Error"],
    ["parked", "Paused"],
  ] as const)("lets the %s label be the accessible name", (state, label) => {
    const html = render(
      <IntegrationStatusPill
        state={state}
        lastSyncAt={new Date(Date.now() - 12 * 60 * 1000)}
        now={new Date()}
      />,
    );
    expect(html).not.toContain("aria-label=");
    expect(html).toContain(label);
  });
});
