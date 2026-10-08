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
import { ColumnCoverage, EncryptionSection } from "../encryption-section";

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
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <ColumnCoverage
          columns={[column("User", "a", 3)]}
          activeKeyId="v2"
          initiallyOpen
        />
      </I18nProvider>,
    );
    expect(html).toMatch(
      /role="region"[^>]*tabindex="0"|tabindex="0"[^>]*role="region"/,
    );
  });
});

function column(model: string, field: string, total: number) {
  return {
    model,
    field,
    kind: "string" as const,
    total,
    byKeyId: { v2: total },
    legacy: 0,
  };
}

describe("encryption coverage — the per-column table", () => {
  const columns = [
    column("User", "withRows", 4),
    column("User", "empty", 0),
    column("Note", "alsoEmpty", 0),
  ];

  function renderCoverage(initiallyOpen: boolean) {
    return renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <ColumnCoverage
          columns={columns}
          activeKeyId="v2"
          initiallyOpen={initiallyOpen}
        />
      </I18nProvider>,
    );
  }

  it("starts collapsed on the page, naming how many columns hold rows", () => {
    status.current = { ...statusWith(1), columns };
    const html = render();
    expect(html).toContain('data-testid="encryption-columns-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Show the table (1 with rows)");
    expect(html).not.toContain('data-slot="encryption-column-rows"');
  });

  it("keeps the toggle's aria-controls target in the tree while collapsed", () => {
    const html = renderCoverage(false);
    expect(html).toContain('aria-controls="encryption-columns-panel"');
    expect(html).toMatch(/<div id="encryption-columns-panel" hidden=""/);
  });

  it("lists only columns with rows when opened, with a toggle for all", () => {
    const html = renderCoverage(true);
    expect(html).toContain("User.withRows");
    expect(html).not.toContain("User.empty");
    expect(html).toContain("Show all 3 columns");
  });
});
