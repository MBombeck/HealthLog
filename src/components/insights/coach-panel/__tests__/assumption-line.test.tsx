/**
 * v1.41 — "Assumed: last 30 days. Change": one quiet line, the change only
 * under the latest answer and only with alternatives.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { CoachAssumption, CoachFollowUp } from "@/lib/ai/coach/types";

import { CoachAssumptionLine, alternativesFor } from "../assumption-line";

const WINDOW: CoachAssumption = {
  kind: "window",
  value: {
    labelKey: "coach.step.window.last30days",
    label: "last 30 days",
    value: { window: "last30days" },
  },
  alternatives: [],
};
const CHANGE: CoachFollowUp = {
  id: "f1",
  kind: "change_assumption",
  labelKey: "coach.followUp.changeAssumption",
  label: "Last 90 days instead",
  reuse: false,
  origin: "server",
  assumption: { kind: "window", value: { window: "last90days" } },
};

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("<CoachAssumptionLine>", () => {
  it("names the assumption in one meta line", () => {
    const html = render(
      <CoachAssumptionLine
        assumptions={[WINDOW]}
        changes={[]}
        messageId={null}
        disabled={false}
      />,
    );
    expect(html).toContain("Assumed: last 30 days.");
    expect(html).toMatch(
      /data-slot="coach-assumption-line"[^>]*class="text-muted-foreground/,
    );
    expect(html).not.toContain("coach-assumption-change");
  });

  it("offers Change under the latest answer, closed until tapped", () => {
    const html = render(
      <CoachAssumptionLine
        assumptions={[WINDOW]}
        changes={[CHANGE]}
        messageId="m1"
        disabled={false}
        onChange={() => {}}
      />,
    );
    expect(html).toContain(">Change</button>");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Last 90 days instead");
  });

  it("matches alternatives to their assumption by kind", () => {
    expect(alternativesFor(WINDOW, [CHANGE])).toEqual([CHANGE]);
    expect(alternativesFor({ ...WINDOW, kind: "metric" }, [CHANGE])).toEqual(
      [],
    );
  });
});
