/**
 * The wizard's dose steps, as a person meets them at 390 px:
 *
 *  - Step 2: the class is optional; Other reads as chosen until another row
 *    is picked.
 *  - Step 3: one question up front. A counted dose ("2 tablets") is not asked
 *    "tablets per dose" again; a strength ("5 mg") is. The pack size belongs
 *    to the supply and folds away.
 *  - Step 7: the per-time dose fields fold away behind one question, open
 *    when the schedule already sets one.
 *  - Step 8: a plain sentence says when each dose counts as on time, late and
 *    missed, from the bands the server applies.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({ canManageDomain: () => false }),
}));
vi.mock("@/lib/queries/use-medication-categories", () => ({
  useMedicationCategories: () => ({ data: [] }),
}));

import { I18nProvider } from "@/lib/i18n/context";

import { Step2Class } from "../steps/step2-class";
import { Step3Dose } from "../steps/step3-dose";
import { Step7Times } from "../steps/step7-times";
import { Step8Summary } from "../steps/step8-summary";
import { emptyWizardPayload, type WizardPayload } from "../wizard-payload";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <QueryClientProvider client={new QueryClient()}>
        {node}
      </QueryClientProvider>
    </I18nProvider>,
  );
}

const base = (patch: Partial<WizardPayload> = {}): WizardPayload => ({
  ...emptyWizardPayload(),
  name: "Ramipril",
  ...patch,
});

describe("Step 2: the class is optional", () => {
  it("shows Other as chosen while nothing is picked", () => {
    const html = render(
      <Step2Class payload={base()} applyPartial={() => {}} />,
    );
    expect(html).toMatch(/data-row="other" data-selected="true"/);
    expect(html.match(/data-selected="true"/g)?.length).toBe(1);
  });
});

describe("Step 3: one dose question", () => {
  it("asks tablets per dose for a strength unit", () => {
    const html = render(
      <Step3Dose
        payload={base({ doseAmount: "5", doseUnit: "mg" })}
        applyPartial={() => {}}
      />,
    );
    expect(html).toContain('data-slot="wizard-units-per-dose-block"');
  });

  it("does not ask it again when the dose counts tablets", () => {
    const html = render(
      <Step3Dose
        payload={base({
          doseAmount: "2",
          doseUnit: "tablets",
          unitsPerDose: "2",
        })}
        applyPartial={() => {}}
      />,
    );
    expect(html).not.toContain('data-slot="wizard-units-per-dose-block"');
  });

  it("still shows a stored count that differs from the dose", () => {
    const html = render(
      <Step3Dose
        payload={base({
          doseAmount: "1",
          doseUnit: "tablets",
          unitsPerDose: "2",
        })}
        applyPartial={() => {}}
      />,
    );
    expect(html).toContain('data-slot="wizard-units-per-dose-block"');
  });

  it("folds the pack size away, and opens it when one is set", () => {
    const closed = render(
      <Step3Dose payload={base({ doseAmount: "5" })} applyPartial={() => {}} />,
    );
    expect(closed).toContain('data-slot="wizard-pack-size-toggle"');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('id="wizard-doses-per-unit"');
    const open = render(
      <Step3Dose
        payload={base({ doseAmount: "5", dosesPerUnit: "28" })}
        applyPartial={() => {}}
      />,
    );
    expect(open).toContain('id="wizard-doses-per-unit"');
  });

  it("no longer pairs the route with the pack size in one misaligned row", () => {
    const html = render(
      <Step3Dose payload={base({ doseAmount: "5" })} applyPartial={() => {}} />,
    );
    // The only two-column row is amount beside unit.
    expect(html.match(/grid-cols-2/g)?.length ?? 0).toBe(1);
  });
});

describe("Step 7: per-time dose fields fold away", () => {
  it("is closed for a schedule that sets none", () => {
    const html = render(
      <Step7Times
        payload={base({ timesOfDay: ["08:00"] })}
        applyPartial={() => {}}
      />,
    );
    expect(html).toContain('data-slot="wizard-schedule-override-toggle"');
    expect(html).not.toContain('id="wizard-schedule-dose"');
  });

  it("is open when the schedule already sets a dose", () => {
    const html = render(
      <Step7Times
        payload={base({ timesOfDay: ["08:00"], scheduleDose: "½ tablet" })}
        applyPartial={() => {}}
      />,
    );
    expect(html).toContain('id="wizard-schedule-dose"');
  });
});

describe("Step 8: when a dose counts as missed, in words", () => {
  function summary(patch: Partial<WizardPayload>) {
    return render(
      <Step8Summary
        payload={base(patch)}
        applyPartial={() => {}}
        mode="create"
        submitError={null}
        onEditSchedule={() => {}}
        onRemoveSchedule={() => {}}
        onAddSchedule={() => {}}
      />,
    );
  }

  it("names the on-time end and the miss cutoff of each daily dose", () => {
    const html = summary({ mode: "recurring", timesOfDay: ["08:00"] });
    expect(html).toContain('data-slot="wizard-window-plan"');
    expect(html).toMatch(/on time until .*9:00.*late until .*12:00/);
  });

  it("says nothing for an as-needed medication", () => {
    const html = summary({ mode: "asNeeded", timesOfDay: [] });
    expect(html).not.toContain('data-slot="wizard-window-plan"');
  });
});
