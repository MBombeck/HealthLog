/**
 * `/coach/plans` with the Coach unavailable.
 *
 * Plans are the person's own record. Before v1.39 the page redirected to
 * `/insights` as soon as the Coach was unavailable, so a person whose Coach
 * the operator switched off could neither read nor erase what it had kept.
 * Now the page stays and turns read-only: every plan is listed and can be
 * removed, while confirming or moving one (Coach use, refused by the PATCH
 * route) is not offered.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const capability = vi.hoisted(() => ({
  answer: null as { available: boolean } | null,
}));
vi.mock("@/hooks/use-ai-capability", () => ({
  useAiCapabilityAnswer: () => capability.answer,
}));

const plan = (id: string, status: string, metric = "WEIGHT") => ({
  id,
  metric,
  ifCue: `cue ${id}`,
  thenAction: `action ${id}`,
  target: null,
  status,
  reviewDate: null,
  sourceConversationId: null,
  createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-09-01T08:00:00.000Z",
});
vi.mock("@/hooks/use-coach-plans", () => ({
  useCoachPlans: () => ({
    data: [
      plan("p-proposed", "proposed"),
      plan("p-active", "active"),
      plan("p-met", "met", "mood vibes"),
    ],
    isError: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
  useCoachPlanMutations: () => ({
    setStatus: { mutate: vi.fn(), isPending: false, variables: undefined },
    remove: { mutate: vi.fn(), isPending: false, variables: undefined },
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { primeMessages } from "@/lib/i18n/load-locale";
import deMessages from "../../../../../messages/de.json";

import CoachPlansPage from "../page";

primeMessages("de", deMessages);

function render(locale: "en" | "de" = "en"): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <CoachPlansPage />
    </I18nProvider>,
  );
}

const count = (html: string, slot: string) =>
  html.split(`data-slot="${slot}"`).length - 1;

describe("/coach/plans", () => {
  it("renders nothing until the account answered", () => {
    capability.answer = null;
    expect(render()).toBe("");
  });

  it("stays readable and erasable with the Coach unavailable", () => {
    capability.answer = { available: false };
    const html = render();
    expect(html).toContain('data-slot="coach-plans-page"');
    expect(count(html, "coach-plan-row")).toBe(3);
    // Every plan can be removed, whatever group it is in.
    expect(count(html, "coach-plan-delete")).toBe(3);
    // Confirming or moving a plan is Coach use and is not offered.
    expect(html).not.toContain('data-slot="coach-plan-accept"');
    expect(html).not.toContain('data-slot="coach-plan-met"');
    expect(html).not.toContain('data-slot="coach-plan-abandon"');
    expect(html).toContain("you can still read and delete your plans");
  });

  it("offers the lifecycle controls with the Coach available", () => {
    capability.answer = { available: true };
    const html = render();
    expect(html).toContain('data-slot="coach-plan-accept"');
    expect(html).toContain('data-slot="coach-plan-met"');
    expect(count(html, "coach-plan-delete")).toBe(1);
    expect(html).not.toContain("you can still read and delete your plans");
  });

  it("names the metric in the reader's language, and an unknown key as written", () => {
    capability.answer = { available: true };
    const html = render("de");
    expect(html.split("<span>Gewicht</span>").length - 1).toBe(2);
    expect(html).toContain("<span>mood vibes</span>");
    expect(html).not.toContain("WEIGHT");
  });
});
