import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.19 — Sys/Dia badge enum-mismatch regression guard.
 *
 * The mobile-list BP-type badge must check the canonical
 * `BLOOD_PRESSURE_SYS` / `BLOOD_PRESSURE_DIA` enum values (matching
 * `prisma/schema.prisma` and `MEASUREMENT_TYPE_LABEL_KEYS`). An earlier
 * implementation checked `BP_SYS` / `BP_DIA` — short forms that never
 * appear in the API payload — so the badge silently never painted on
 * mobile. The desktop table was unaffected because it routes through
 * `MEASUREMENT_TYPE_LABEL_KEYS[m.type]`.
 *
 * This guard renders the mobile list with one systolic + one diastolic
 * row and asserts both labels show up.
 */

const baseMeasurements = [
  {
    id: "m-sys-1",
    type: "BLOOD_PRESSURE_SYS",
    value: 117,
    unit: "mmHg",
    source: "MANUAL",
    measuredAt: "2026-05-09T08:30:00.000Z",
    notes: null,
  },
  {
    id: "m-dia-1",
    type: "BLOOD_PRESSURE_DIA",
    value: 78,
    unit: "mmHg",
    source: "MANUAL",
    measuredAt: "2026-05-09T08:30:00.000Z",
    notes: null,
  },
];

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/measurements",
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: { measurements: baseMeasurements, meta: { total: 2 } },
    isLoading: false,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "testuser", role: "USER" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

// v1.28.42 (H3) — the list now mounts only the active layout, so drive the
// breakpoint hook to assert the badge in each branch independently.
vi.mock("@/hooks/use-is-mobile", () => ({
  useIsMobile: vi.fn(() => false),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { MeasurementList } from "../measurement-list";
import { useIsMobile } from "@/hooks/use-is-mobile";

function render(locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <MeasurementList />
    </I18nProvider>,
  );
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

describe("MeasurementList — Sys/Dia disambiguation badge (mobile list)", () => {
  // v1.28.42 (H3) — only the active layout mounts now (previously both the
  // desktop table and the mobile card list rendered, CSS-hidden). Assert each
  // label appears exactly once per branch so the mobile-enum regression this
  // guard was written for (badge silently absent on mobile) still fails loudly.

  it("renders the Sys badge in the desktop table", () => {
    vi.mocked(useIsMobile).mockReturnValue(false);
    expect(countOccurrences(render("en"), ">Sys<")).toBe(1);
  });

  it("renders the Sys badge in the mobile list", () => {
    vi.mocked(useIsMobile).mockReturnValue(true);
    expect(countOccurrences(render("en"), ">Sys<")).toBe(1);
  });

  it("renders the Dia badge in the desktop table", () => {
    vi.mocked(useIsMobile).mockReturnValue(false);
    expect(countOccurrences(render("en"), ">Dia<")).toBe(1);
  });

  it("renders the Dia badge in the mobile list", () => {
    vi.mocked(useIsMobile).mockReturnValue(true);
    expect(countOccurrences(render("en"), ">Dia<")).toBe(1);
  });

  it("renders Sys + Dia in each branch under the German locale too", () => {
    vi.mocked(useIsMobile).mockReturnValue(false);
    const desktop = render("de");
    expect(countOccurrences(desktop, ">Sys<")).toBe(1);
    expect(countOccurrences(desktop, ">Dia<")).toBe(1);

    vi.mocked(useIsMobile).mockReturnValue(true);
    const mobile = render("de");
    expect(countOccurrences(mobile, ">Sys<")).toBe(1);
    expect(countOccurrences(mobile, ">Dia<")).toBe(1);
  });

  it("names the type on every mobile row, not only blood pressure", () => {
    vi.mocked(useIsMobile).mockReturnValue(true);
    expect(
      countOccurrences(render("en"), 'data-slot="measurement-row-type"'),
    ).toBe(baseMeasurements.length);
  });
});
