/**
 * The off-host card paints what the response says, including the case an
 * operator most needs stated out loud: this host is not sending anything
 * anywhere. A card that renders an empty list on an unconfigured host reads
 * as "no problems".
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { BackupsList } from "@/types/backups";

const queryResult = vi.hoisted(() => ({
  current: {
    data: null as BackupsList | null,
    isLoading: false,
    isError: false,
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ ...queryResult.current, refetch: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { OffhostBackupsSection } from "../offhost-backups-section";

const QUIET = {
  activity: { runningSince: null, interrupted: [] },
  pendingDeletions: { count: 0, oldestRequestedAt: null, lastFailure: null },
  lifecycle: { state: "configured" as const, expirationDays: 30 },
};

function render(data: BackupsList["offhost"] | null): string {
  queryResult.current = {
    data:
      data === null
        ? null
        : ({
            rows: [],
            retentionDays: 90,
            schedule: null,
            offhost: data,
          } as unknown as BackupsList),
    isLoading: false,
    isError: false,
  };
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <OffhostBackupsSection />
    </I18nProvider>,
  );
}

describe("<OffhostBackupsSection>", () => {
  it("says off-host backup is not configured rather than showing an empty list", () => {
    const html = render({
      configured: false,
      periodHours: 24,
      rows: [],
      ...QUIET,
    });
    expect(html).toContain("Off-host backup is not configured");
    expect(html).not.toContain('data-slot="offhost-backup-rows"');
  });

  it("paints one row per account with its verdict", () => {
    const html = render({
      configured: true,
      periodHours: 24,
      ...QUIET,
      rows: [
        {
          userId: "u1",
          username: "account-one",
          lastAttemptAt: "2026-09-10T06:00:00.000Z",
          lastSuccessAt: "2026-09-10T06:00:00.000Z",
          sizeBytes: 4096,
          ageHours: 3,
          freshness: "fresh",
        },
        {
          userId: "u2",
          username: "account-two",
          lastAttemptAt: "2026-09-06T06:00:00.000Z",
          lastSuccessAt: "2026-09-06T06:00:00.000Z",
          sizeBytes: 2048,
          ageHours: 99,
          freshness: "stale",
        },
        {
          userId: "u3",
          username: "account-three",
          lastAttemptAt: "2026-09-10T02:30:00.000Z",
          lastSuccessAt: null,
          sizeBytes: null,
          ageHours: null,
          freshness: "never",
        },
        {
          userId: "u4",
          username: "account-four",
          lastAttemptAt: null,
          lastSuccessAt: null,
          sizeBytes: null,
          ageHours: null,
          freshness: "unknown",
        },
      ],
    });

    expect(html).toContain('data-offhost-freshness="fresh"');
    expect(html).toContain('data-offhost-freshness="stale"');
    expect(html).toContain('data-offhost-freshness="never"');
    expect(html).toContain('data-offhost-freshness="unknown"');
    expect(html).toContain("account-two");
    // The account a run walked and found nothing for says that, with the
    // instant it was checked.
    expect(html).toContain("Nothing has landed for this account");
    // The account no run has recorded says THAT — not "never", which would
    // claim the bucket is empty on the strength of an empty ledger.
    expect(html).toContain("No nightly run has recorded this account yet");
    // Never the bucket's own coordinates.
    expect(html).not.toMatch(/secret|access[- ]key/i);
  });

  it("says when the bucket keeps copies forever, and when deletions are stuck", () => {
    const html = render({
      configured: true,
      periodHours: 24,
      rows: [],
      activity: { runningSince: null, interrupted: [] },
      pendingDeletions: {
        count: 2,
        oldestRequestedAt: "2026-09-20T10:00:00.000Z",
        lastFailure: "AccessDenied",
      },
      lifecycle: { state: "missing", expirationDays: null },
    });
    expect(html).toContain('data-lifecycle-state="missing"');
    expect(html).toContain("no lifecycle rule");
    expect(html).toContain('data-slot="offhost-pending-deletions"');
    expect(html).toContain("AccessDenied");
  });

  it("states the expiry the bucket enforces", () => {
    const html = render({
      configured: true,
      periodHours: 24,
      rows: [],
      ...QUIET,
    });
    expect(html).toContain("after 30 days");
    expect(html).not.toContain('data-slot="offhost-pending-deletions"');
  });

  it("names an account a run died under, and says since when one runs", () => {
    const html = render({
      configured: true,
      periodHours: 24,
      rows: [],
      ...QUIET,
      activity: {
        runningSince: "2026-10-04T02:30:00.000Z",
        interrupted: [
          {
            userId: "u1",
            username: "account-one",
            startedAt: "2026-10-03T02:31:00.000Z",
          },
        ],
      },
    });
    expect(html).toContain('data-slot="backup-pass-running"');
    expect(html).toContain('data-interrupted-username="account-one"');
    expect(html).toContain("never finished");
  });
});
