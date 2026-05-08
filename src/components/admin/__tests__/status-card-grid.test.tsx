import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { StatusBadge, buildCards } from "../status-card-grid";
import type { StatusOverview } from "@/app/api/admin/status-overview/route";

const mockOverview: StatusOverview = {
  users: { severity: "good", total: 3, admins: 1, newThisWeek: 1 },
  integrations: {
    severity: "good",
    withings: 1,
    moodLog: 0,
    telegram: 1,
    ntfy: 0,
    webPush: 2,
  },
  monitoring: {
    severity: "caution",
    glitchtipEnabled: true,
    umamiEnabled: false,
    wideEventsEnabled: true,
    lastErrorAt: null,
  },
  backups: {
    severity: "alert",
    lastBackupAt: null,
    backedUpUsers: 0,
    retentionDays: 90,
  },
  maintenance: {
    severity: "good",
    workerRunning: true,
    workerUptimeSeconds: 3600,
    lastIdempotencyCleanup: new Date(Date.now() - 60_000).toISOString(),
    lastAuditLogCleanup: null,
  },
  auditLog: {
    severity: "info",
    eventsLast30d: 42,
    lastLoginAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  },
};

describe("<StatusBadge>", () => {
  it("renders a colored dot plus a text label (never color-only)", () => {
    const html = renderToStaticMarkup(<StatusBadge severity="good" />);
    // dot must be aria-hidden so SR users don't hear it
    expect(html).toContain('aria-hidden="true"');
    // label must be present so color-blind users can read state
    expect(html).toContain("Healthy");
    // wrapper carries the announcement
    expect(html).toContain('aria-label="Status: Healthy"');
  });

  it("maps severity to the §2.6 dracula color tokens", () => {
    const cases: Array<
      [Parameters<typeof StatusBadge>[0]["severity"], string]
    > = [
      ["good", "var(--dracula-green)"],
      ["info", "var(--dracula-cyan)"],
      ["caution", "var(--dracula-orange)"],
      ["alert", "var(--dracula-red)"],
      ["pending", "var(--muted-foreground)"],
    ];
    for (const [severity, token] of cases) {
      const html = renderToStaticMarkup(<StatusBadge severity={severity} />);
      expect(html).toContain(token);
    }
  });

  it("respects an explicit label override", () => {
    const html = renderToStaticMarkup(
      <StatusBadge severity="alert" label="Disk full" />,
    );
    expect(html).toContain("Disk full");
    expect(html).toContain('aria-label="Status: Disk full"');
  });
});

describe("buildCards()", () => {
  it("returns exactly 6 cards in the §3.4 admin order", () => {
    const cards = buildCards(mockOverview);
    expect(cards).toHaveLength(6);
    expect(cards.map((c) => c.title)).toEqual([
      "Users",
      "Integrations",
      "Monitoring",
      "Backups",
      "Maintenance",
      "Audit log",
    ]);
  });

  it("propagates severity from the aggregator response", () => {
    const cards = buildCards(mockOverview);
    expect(cards[0].severity).toBe("good"); // users
    expect(cards[2].severity).toBe("caution"); // monitoring
    expect(cards[3].severity).toBe("alert"); // backups (no backup yet)
    expect(cards[5].severity).toBe("info"); // audit log
  });

  it("links each card to a manageable destination", () => {
    const cards = buildCards(mockOverview);
    for (const card of cards) {
      expect(card.href.startsWith("/admin")).toBe(true);
      expect(card.cta.length).toBeGreaterThan(0);
    }
  });

  it("includes 3 metric tuples per card", () => {
    const cards = buildCards(mockOverview);
    for (const card of cards) {
      expect(card.metrics).toHaveLength(3);
    }
  });

  it("renders worker status as plain text, not color alone", () => {
    const cards = buildCards(mockOverview);
    const maintenance = cards.find((c) => c.title === "Maintenance");
    expect(maintenance?.metrics[0].value).toBe("Running");
  });
});
