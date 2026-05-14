import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { TitrationSection } from "@/components/medications/TitrationSection";

/**
 * v1.4.25 W19f — TitrationSection SSR smoke tests.
 *
 * Same testing convention as `SchedulingSection.test.tsx`:
 * `renderToStaticMarkup` + seeded react-query cache. Interactive
 * branches (loading spinner, fetch-error) are covered by the API
 * route tests + the pure ladder tests; surface tests here pin the
 * static-render contract:
 *
 *   1. Header + drug INN render.
 *   2. Each ladder step renders with dose + typical-weeks label.
 *   3. The current step has a "You are here" caption.
 *   4. The next-step caption renders when a next step exists.
 *   5. The ceiling message renders when the user is on the top
 *      step (no next step).
 *   6. The non-standard dose caption renders when current step is
 *      null but the ladder is non-empty.
 *   7. The disclaimer + EMA source link always render with data.
 *   8. Empty ladder → empty-state copy renders.
 *   9. The escalationDueHint copy is observational, not prescriptive.
 *  10. German locale renders.
 */

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnMount: false,
      },
    },
  });
}

interface SeedShape {
  drugId: string;
  drugInn: string;
  ladder: Array<{ stepIndex: number; doseMg: number; typicalWeeks: number }>;
  currentStep: { stepIndex: number; doseMg: number; typicalWeeks: number } | null;
  currentStepIndex: number | null;
  weeksOnCurrentStep: number;
  nextStep: { stepIndex: number; doseMg: number; typicalWeeks: number } | null;
  escalationDue: boolean;
  sourceEMA: string;
}

function seed(client: QueryClient, medId: string, payload: SeedShape) {
  client.setQueryData(["medications", medId, "titration"], payload);
}

function render(
  node: React.ReactNode,
  client: QueryClient,
  locale: "en" | "de" = "en",
) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </I18nProvider>,
  );
}

const TIRZEPATIDE_LADDER = [
  { stepIndex: 0, doseMg: 2.5, typicalWeeks: 4 },
  { stepIndex: 1, doseMg: 5, typicalWeeks: 4 },
  { stepIndex: 2, doseMg: 7.5, typicalWeeks: 4 },
  { stepIndex: 3, doseMg: 10, typicalWeeks: 4 },
  { stepIndex: 4, doseMg: 12.5, typicalWeeks: 4 },
  { stepIndex: 5, doseMg: 15, typicalWeeks: 4 },
];

const SEED_ON_STEP_5MG: SeedShape = {
  drugId: "tirzepatide",
  drugInn: "Tirzepatide",
  ladder: TIRZEPATIDE_LADDER,
  currentStep: TIRZEPATIDE_LADDER[1],
  currentStepIndex: 1,
  weeksOnCurrentStep: 2,
  nextStep: TIRZEPATIDE_LADDER[2],
  escalationDue: false,
  sourceEMA:
    "https://www.ema.europa.eu/en/documents/product-information/mounjaro-epar-product-information_en.pdf",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<TitrationSection> — surface render", () => {
  it("renders the section heading and drug INN", () => {
    const client = makeClient();
    seed(client, "med-1", SEED_ON_STEP_5MG);
    const html = render(<TitrationSection medicationId="med-1" />, client);
    expect(html).toContain("Titration ladder");
    expect(html).toContain("Tirzepatide");
    expect(html).toContain("Standard ladder (EMA reference)");
  });

  it("renders every step on the ladder", () => {
    const client = makeClient();
    seed(client, "med-1", SEED_ON_STEP_5MG);
    const html = render(<TitrationSection medicationId="med-1" />, client);
    for (const step of TIRZEPATIDE_LADDER) {
      // Each step's dose label appears (e.g. "2.5 mg", "15 mg").
      expect(html).toContain(`${step.doseMg} mg`);
    }
    // Step ladder count = 6 steps; each step renders one card.
    const stepCards = html.match(/data-slot="titration-step"/g) ?? [];
    expect(stepCards.length).toBe(6);
  });

  it('renders "You are here" on the current step only', () => {
    const client = makeClient();
    seed(client, "med-1", SEED_ON_STEP_5MG);
    const html = render(<TitrationSection medicationId="med-1" />, client);
    expect(html).toContain("You are here");
    // Only one "you are here" caption rendered, on the matched step.
    expect(html.match(/You are here/g)?.length).toBe(1);
  });

  it("renders the next-step caption when a next step exists", () => {
    const client = makeClient();
    seed(client, "med-1", SEED_ON_STEP_5MG);
    const html = render(<TitrationSection medicationId="med-1" />, client);
    expect(html).toContain("Next step (typical): 7.5 mg");
  });

  it("renders the ceiling message at the top of the ladder", () => {
    const client = makeClient();
    seed(client, "med-1", {
      ...SEED_ON_STEP_5MG,
      currentStep: TIRZEPATIDE_LADDER[5],
      currentStepIndex: 5,
      nextStep: null,
    });
    const html = render(<TitrationSection medicationId="med-1" />, client);
    expect(html).toContain("You are at the top of the standard ladder.");
  });

  it("renders the non-standard dose caption when current step is null", () => {
    const client = makeClient();
    seed(client, "med-1", {
      ...SEED_ON_STEP_5MG,
      currentStep: null,
      currentStepIndex: null,
      nextStep: null,
      weeksOnCurrentStep: 0,
    });
    const html = render(<TitrationSection medicationId="med-1" />, client);
    expect(html).toContain(
      "Current dose is outside the standard ladder buckets.",
    );
  });

  it("always renders the disclaimer and the EMA-source link", () => {
    const client = makeClient();
    seed(client, "med-1", SEED_ON_STEP_5MG);
    const html = render(<TitrationSection medicationId="med-1" />, client);
    expect(html).toContain(
      "EMA reference values. Talk to your doctor before changing doses.",
    );
    expect(html).toContain("EMA source");
    expect(html).toContain("mounjaro-epar-product-information");
  });

  it("renders the empty-state copy when the ladder is empty", () => {
    const client = makeClient();
    seed(client, "med-1", {
      ...SEED_ON_STEP_5MG,
      ladder: [],
      currentStep: null,
      currentStepIndex: null,
      nextStep: null,
    });
    const html = render(<TitrationSection medicationId="med-1" />, client);
    expect(html).toContain(
      "No dose history yet. Log a dose to see where you are on the ladder.",
    );
  });

  it("renders the escalation-due hint as an observation, not a prescription", () => {
    const client = makeClient();
    seed(client, "med-1", {
      ...SEED_ON_STEP_5MG,
      weeksOnCurrentStep: 6,
      escalationDue: true,
    });
    const html = render(<TitrationSection medicationId="med-1" />, client);
    // The copy must NOT prescribe an action ("you should step up").
    expect(html).not.toMatch(/should step up/i);
    expect(html).not.toMatch(/must step up/i);
    expect(html).not.toMatch(/recommend.*step up/i);
    // The observational template must be rendered.
    expect(html).toContain("the ladder typically steps up around");
    // The escaped apostrophe is the SSR render of the curly-apostrophe-free
    // template; we assert on the unencoded plain segment instead of the
    // contraction itself to stay robust to the renderer's HTML entity choice.
    expect(html).toContain("been on this step for 6 weeks");
  });

  it("renders the section heading in German", () => {
    const client = makeClient();
    seed(client, "med-1", SEED_ON_STEP_5MG);
    const html = render(
      <TitrationSection medicationId="med-1" />,
      client,
      "de",
    );
    expect(html).toContain("Titrationsstufen");
    expect(html).toContain("Standard-Schema (EMA-Referenz)");
    expect(html).toContain("Hier stehst du");
  });
});
