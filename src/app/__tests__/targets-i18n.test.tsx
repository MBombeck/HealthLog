import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.19 phase A7 — the maintainer reported the `/targets` (Zielwerte) page
 * still surfaces English status labels even when the rest of the UI
 * renders in German: "Low / On Target / Stable / Moderate" stayed in
 * the source language. The card titles ("Weight", "Blood pressure",
 * "Body fat" …) had the same issue — server returns English
 * strings, the page renders them verbatim.
 *
 * Translate every classification category and card label on the
 * client. The server keeps emitting stable English keys (so external
 * consumers / logs don't churn); the page resolves them to i18n
 * strings via `useTranslations()`.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/targets",
}));

const sampleData = {
  targets: [
    {
      type: "WEIGHT",
      label: "Weight",
      current: 88.2,
      average30: 88.6,
      trend: "stable",
      unit: "kg",
      range: { min: 60, max: 80 },
      classification: { category: "Normal", color: "#50fa7b" },
      source: "WHO BMI",
    },
    {
      type: "BLOOD_PRESSURE_IN_TARGET",
      label: "Blood pressure on target",
      current: 65,
      average30: 65,
      trend: null,
      unit: "%",
      range: { min: 70, max: 100 },
      classification: { category: "Moderate", color: "#f1fa8c" },
      source: "ESH 2023",
    },
    {
      type: "PULSE",
      label: "Resting pulse",
      current: 72,
      average30: 72,
      trend: "stable",
      unit: "bpm",
      range: { min: 60, max: 100 },
      classification: { category: "On target", color: "#50fa7b" },
      source: "AHA",
    },
    {
      type: "MOOD_STABILITY",
      label: "Mood stability",
      current: 0.6,
      average30: 0.6,
      trend: null,
      unit: "σ",
      range: { min: 0, max: 0.5 },
      classification: { category: "Stable", color: "#f1fa8c" },
      source: "moodLog",
    },
    {
      type: "MEDICATION_COMPLIANCE",
      label: "Medication compliance",
      current: 60,
      average30: 60,
      trend: null,
      unit: "%",
      range: { min: 90, max: 100 },
      classification: { category: "Low", color: "#ff5555" },
      source: "7-day",
    },
  ],
  bpDiastolic: { current: null, average30: null, range: null },
  profile: { heightCm: 180, age: 35, gender: "MALE", glucoseUnit: null },
};

vi.mock("@tanstack/react-query", () => {
  const noopClient = {
    invalidateQueries: vi.fn(),
    setQueryData: vi.fn(),
    getQueryData: vi.fn(),
    refetchQueries: vi.fn(),
  };
  return {
    useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
      // v1.4.25 W3e — the targets page now also queries
      // ["insights", "provider-chain"] to gate the per-card Coach
      // CTA. Return null for that query (no AI provider configured)
      // so the CTA hides and the existing test cases keep asserting
      // the unchanged visual surface.
      if (Array.isArray(queryKey) && queryKey[1] === "provider-chain") {
        return {
          data: null,
          isLoading: false,
          isError: false,
          refetch: vi.fn(),
        };
      }
      return {
        data: sampleData,
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      };
    },
    useQueryClient: () => noopClient,
    useMutation: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
      reset: vi.fn(),
    }),
  };
});

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      username: "marc",
      email: "marc@example.com",
      role: "USER",
    },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import TargetsPage from "../targets/page";

function render(locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <TargetsPage />
    </I18nProvider>,
  );
}

describe("/targets page — i18n status labels and titles", () => {
  it("translates card titles to German when the locale is `de`", () => {
    const html = render("de");
    expect(html).toContain("Gewicht"); // Weight
    expect(html).toContain("Ruhepuls"); // Resting pulse
    expect(html).toContain("Stimmungsstabilität"); // Mood stability
    expect(html).toContain("Einnahmetreue"); // Medication compliance
    // Server-emitted English labels must not leak.
    expect(html).not.toContain("Resting pulse");
    expect(html).not.toContain("Mood stability");
    expect(html).not.toContain("Medication compliance");
  });

  it("translates every status badge category to German", () => {
    const html = render("de");
    // the maintainer explicitly named these in his bug report.
    expect(html).not.toMatch(/>Low</);
    expect(html).not.toMatch(/>On target</);
    expect(html).not.toMatch(/>Stable</);
    expect(html).not.toMatch(/>Moderate</);
    // Their German renderings must show up instead.
    expect(html).toContain("Niedrig"); // Low
    expect(html).toContain("Im Zielbereich"); // On target
    expect(html).toContain("Stabil"); // Stable
    expect(html).toContain("Moderat"); // Moderate
    // "Normal" is identical in EN and DE — the badge should still
    // render the localised key (`targets.status.normal` → "Normal"),
    // not the raw server string.
    expect(html).toContain("Normal");
  });

  it("English locale still surfaces the original English status labels (no breakage)", () => {
    const html = render("en");
    expect(html).toContain("Normal");
    expect(html).toContain("Moderate");
    expect(html).toContain("On target");
    expect(html).toContain("Stable");
    expect(html).toContain("Low");
  });
});
