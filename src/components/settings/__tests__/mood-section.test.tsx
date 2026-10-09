/**
 * v1.17 — the "Stimmungs-Tags" settings section (`/settings/mood`).
 *
 * SSR smoke assertions matching the rest of the settings suite: the
 * three management cards (groups / tags / archived) render from one
 * mocked manage read, custom labels paint decrypted (never the raw
 * key), hidden catalogue rows dim, archived custom tags land in the
 * archived card with restore + purge affordances, and both locales
 * resolve end-to-end. The interactive contracts (optimistic flips,
 * reorder PUTs) ride the pure helpers pinned in
 * `src/components/mood/manage/__tests__/catalog-helpers.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { ManageCatalog } from "@/components/mood/manage/use-mood-tag-manage";

const FIXTURE: ManageCatalog = {
  categories: [
    {
      key: "feelings",
      labelKey: "mood.tagCategory.feelings",
      label: null,
      icon: "Smile",
      custom: false,
      tags: [
        {
          key: "happy",
          labelKey: "mood.tag.happy",
          label: null,
          icon: "Smile",
          kind: "BINARY",
          scaleMin: 0,
          scaleMax: 1,
          inverse: false,
          custom: false,
          hidden: false,
          usageCount: 12,
        },
        {
          key: "stressed",
          labelKey: "mood.tag.stressed",
          label: null,
          icon: "AlertTriangle",
          kind: "BINARY",
          scaleMin: 0,
          scaleMax: 1,
          inverse: true,
          custom: false,
          hidden: true,
          usageCount: 0,
        },
      ],
    },
    {
      key: "customcat:g1",
      labelKey: "customcat:g1",
      label: "Garten",
      icon: "Leaf",
      custom: true,
      tags: [
        {
          key: "custom:1",
          labelKey: "custom:1",
          label: "Gartenarbeit",
          icon: "Leaf",
          kind: "BINARY",
          scaleMin: 0,
          scaleMax: 1,
          inverse: false,
          custom: true,
          archived: false,
          usageCount: 3,
        },
        {
          key: "custom:2",
          labelKey: "custom:2",
          label: "Altes Tag",
          icon: "Tag",
          kind: "BINARY",
          scaleMin: 0,
          scaleMax: 1,
          inverse: false,
          custom: true,
          archived: true,
          usageCount: 5,
        },
      ],
    },
  ],
};

const queryState: { catalog: ManageCatalog | null; loading: boolean } = {
  catalog: FIXTURE,
  loading: false,
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (
      Array.isArray(queryKey) &&
      queryKey[0] === "mood-tag-catalog" &&
      queryKey[1] === "manage"
    ) {
      return { data: queryState.catalog, isLoading: queryState.loading };
    }
    return { data: null, isLoading: false };
  },
  useQueryClient: () => ({
    setQueryData: vi.fn(),
    getQueryData: vi.fn(),
    cancelQueries: vi.fn(),
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/charts/reduced-motion", () => ({
  prefersReducedMotion: () => true,
}));

vi.mock("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { SettingsSectionFrame } from "./section-frame-harness";
import { MoodSection } from "../mood-section";

function render(locale: "en" | "de" = "en"): string {
  // v1.18.6 (W9) — the visible heading (with the historic id) comes from the
  // shared frame the route wraps the section in.
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <SettingsSectionFrame slug="mood">
        <MoodSection />
      </SettingsSectionFrame>
    </I18nProvider>,
  );
}

beforeEach(() => {
  queryState.catalog = FIXTURE;
  queryState.loading = false;
});

describe("<MoodSection> — SSR smoke", () => {
  it("renders the section heading via i18n (no raw keys)", () => {
    // v1.18.1 (D0) — the section blurb was dropped; the sr-only heading + the
    // card content carry the meaning.
    const html = render();
    expect(html).toContain("settings-section-mood-title");
    expect(html).not.toContain("settings.sections.");
    expect(html).not.toContain("mood.manage.");
  });

  it("renders the German copy end-to-end", () => {
    const html = render("de");
    expect(html).toContain("Neue Gruppe");
    expect(html).toContain("Neuer Tag");
    expect(html).toContain("Archivierte Tags");
  });

  it("hosts the three management cards from ONE manage read", () => {
    const html = render();
    expect(html).toContain('data-slot="mood-tag-groups-card"');
    expect(html).toContain('data-slot="mood-tag-manager-card"');
    expect(html).toContain('data-slot="mood-archived-tags-card"');
  });

  it("lists every group — seeded by i18n key, custom by decrypted label", () => {
    const html = render();
    expect(html).toContain("Feelings");
    expect(html).toContain("Garten");
    // The custom group's raw key must never paint as text (it remains
    // present as a `data-group` hook for the reorder wiring).
    expect(html).not.toContain("&gt;customcat:g1&lt;");
    expect(html).not.toContain(">customcat:g1<");
  });

  it("seeded groups reorder only — the kebab is reserved for own groups", () => {
    const html = render();
    const groupRows = html.match(/data-slot="mood-group-row"/g);
    expect(groupRows?.length ?? 0).toBe(2);
    // One kebab per CUSTOM group row; the seeded row carries none.
    const kebabs = html.match(/More options: Garten/g);
    expect(kebabs?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(html).not.toContain("More options: Feelings");
  });

  it("renders custom tags by decrypted label, never the raw key", () => {
    const html = render();
    expect(html).toContain("Gartenarbeit");
    expect(html).not.toContain("custom:1</");
  });

  it("dims a hidden catalogue row and labels its show-toggle", () => {
    const html = render();
    expect(html).toMatch(
      /data-slot="mood-tag-manage-row"[^>]*data-hidden="true"/,
    );
    expect(html).toContain("Show tag: stressed");
  });

  it("surfaces the usage count badge", () => {
    const html = render();
    expect(html).toContain("12 entries");
  });

  it("archived card lists the archived custom tag with restore + purge", () => {
    const html = render();
    expect(html).toContain('data-slot="mood-archived-row"');
    expect(html).toContain("Altes Tag");
    expect(html).toContain("Restore");
    expect(html).toContain("Delete permanently: Altes Tag");
    // The active custom tag must NOT appear in the archived card.
    const archivedCard = html.slice(
      html.indexOf('data-slot="mood-archived-tags-card"'),
    );
    expect(archivedCard).not.toContain("Gartenarbeit");
  });

  it("archived wording makes clear history stays (German)", () => {
    const html = render("de");
    expect(html).toContain(
      "Archivierte Tags bleiben in deinen bisherigen Einträgen erhalten",
    );
  });

  it("shows the groups empty-state when the user owns no groups", () => {
    queryState.catalog = {
      categories: FIXTURE.categories.filter((c) => !c.custom),
    };
    const html = render();
    expect(html).toContain('data-slot="mood-groups-empty"');
    expect(html).toContain("No own groups yet.");
  });

  it("shows the archived empty-state when nothing is archived", () => {
    queryState.catalog = {
      categories: FIXTURE.categories.map((c) => ({
        ...c,
        tags: c.tags.filter((t) => t.archived !== true),
      })),
    };
    const html = render();
    expect(html).toContain('data-slot="mood-archived-empty"');
    expect(html).toContain("Nothing archived.");
  });
});
