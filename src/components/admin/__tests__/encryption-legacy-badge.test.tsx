import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// "Safe to drop the legacy key" needs a legacy key to drop. With a single
// configured key the server's `safeToDropRetiredKeys` is vacuously true, and
// the coverage card used to name a key that does not exist.

const status = {
  current: {} as Record<string, unknown>,
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: status.current,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("../key-backup-card", () => ({ KeyBackupCard: () => null }));

import { I18nProvider } from "@/lib/i18n/context";
import { EncryptionSection } from "../encryption-section";

function statusWith(configuredKeyCount: number) {
  return {
    activeKeyId: "v2",
    configuredKeyCount,
    rotationComplete: true,
    totalRows: 10,
    activeRows: 10,
    staleRows: 0,
    columns: [],
    rotation: {
      state: "idle",
      lastRequestedAt: null,
      lastCompletedAt: null,
      lastResult: null,
    },
    backups: {
      stored: [],
      unrecorded: { copies: 0, oldestAt: null },
      offhost: [],
      offhostExpirationDays: null,
      retiredKeysStillNeeded: [],
    },
    safeToDropRetiredKeys: true,
  };
}

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <EncryptionSection />
    </I18nProvider>,
  );
}

describe("encryption coverage — the legacy-key badge", () => {
  beforeEach(() => {
    status.current = {};
  });

  it("offers the drop only when a retired key is configured", () => {
    status.current = statusWith(2);
    expect(render()).toContain("Safe to drop the legacy key");
  });

  it("says nothing about a legacy key when only one key exists", () => {
    status.current = statusWith(1);
    const html = render();
    expect(html).not.toContain("Safe to drop the legacy key");
    expect(html).not.toContain('data-slot="encryption-backups-need-keys"');
  });

  it("names the per-column table as a focusable scroll region", () => {
    status.current = statusWith(1);
    expect(render()).toMatch(
      /role="region"[^>]*tabindex="0"|tabindex="0"[^>]*role="region"/,
    );
  });
});
