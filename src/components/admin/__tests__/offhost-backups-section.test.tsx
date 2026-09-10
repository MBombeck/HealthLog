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
    const html = render({ configured: false, periodHours: 24, rows: [] });
    expect(html).toContain("Off-host backup is not configured");
    expect(html).not.toContain('data-slot="offhost-backup-rows"');
  });

  it("paints one row per account with its verdict", () => {
    const html = render({
      configured: true,
      periodHours: 24,
      rows: [
        {
          userId: "u1",
          username: "account-one",
          lastSuccessAt: "2026-09-10T06:00:00.000Z",
          sizeBytes: 4096,
          ageHours: 3,
          freshness: "fresh",
        },
        {
          userId: "u2",
          username: "account-two",
          lastSuccessAt: "2026-09-06T06:00:00.000Z",
          sizeBytes: 2048,
          ageHours: 99,
          freshness: "stale",
        },
        {
          userId: "u3",
          username: "account-three",
          lastSuccessAt: null,
          sizeBytes: null,
          ageHours: null,
          freshness: "never",
        },
      ],
    });

    expect(html).toContain('data-offhost-freshness="fresh"');
    expect(html).toContain('data-offhost-freshness="stale"');
    expect(html).toContain('data-offhost-freshness="never"');
    expect(html).toContain("account-two");
    // The account with no object says so instead of showing a blank cell.
    expect(html).toContain("No copy has ever reached the bucket");
    // Never the bucket's own coordinates.
    expect(html).not.toMatch(/secret|access[- ]key/i);
  });
});
