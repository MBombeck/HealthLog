import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { MedicationCard } from "@/components/medications/medication-card";
import {
  Glp1MedicationCard,
  type Glp1Medication,
} from "@/components/medications/glp1-medication-card";
import { MedicationComplianceBars } from "@/components/medications/card-parts/medication-compliance-bars";
import { MedicationStatusPill } from "@/components/medications/card-parts/medication-status-pill";
import { MedicationIntakeActions } from "@/components/medications/card-parts/medication-intake-actions";
import { MedicationStateBadges } from "@/components/medications/card-parts/medication-state-badges";

/**
 * v1.7.2 — the medication-card status pill, compliance bars, intake-action
 * row, and state badges are shared presentational components consumed by
 * both the generic `<MedicationCard>` and the `<Glp1MedicationCard>`. The
 * symmetry between the two variants is now structural (one component, two
 * call sites) rather than two hand-synced JSX blocks.
 *
 * These tests pin the load-bearing seams of the extracted parts and the
 * unified streak/warning token so a regression can't reopen the drift.
 */

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  });
}

function render(node: React.ReactNode, client?: QueryClient) {
  const tree = client ? (
    <QueryClientProvider client={client}>{node}</QueryClientProvider>
  ) : (
    node
  );
  return renderToStaticMarkup(<I18nProvider initialLocale="en">{tree}</I18nProvider>);
}

describe("medication card-parts — shared presentational components", () => {
  it("compliance bars render the 7d / 30d labels and the day-streak flame", () => {
    const html = render(
      <MedicationComplianceBars rate7={90} rate30={88} streak={5} />,
    );
    expect(html).toContain("7-day compliance");
    expect(html).toContain("30-day compliance");
    expect(html).toContain("90%");
    expect(html).toContain("88%");
    expect(html).toContain("lucide-flame");
    // Canonical streak/warning token — NOT the Tailwind-stock drift.
    expect(html).toContain("text-dracula-orange");
    expect(html).not.toContain("text-orange-400");
  });

  it("compliance bars hide the streak flame when streak is zero", () => {
    const html = render(
      <MedicationComplianceBars rate7={90} rate30={88} streak={0} />,
    );
    expect(html).not.toContain("lucide-flame");
  });

  it("status pill stamps the success token + take-now glyph in window", () => {
    const html = render(
      <MedicationStatusPill
        status="in_window"
        windowStart="08:00"
        windowEnd="20:00"
      />,
    );
    expect(html).toContain("Take now");
    expect(html).toContain("text-success");
    expect(html).toContain("lucide-circle-check");
  });

  it("status pill stamps the warning token + glyph when very late", () => {
    const html = render(
      <MedicationStatusPill
        status="very_late"
        windowStart="08:00"
        windowEnd="20:00"
      />,
    );
    expect(html).toContain("text-warning");
    expect(html).toContain("lucide-triangle-alert");
  });

  it("intake actions row carries exactly the take + skip buttons", () => {
    const html = render(
      <MedicationIntakeActions intakeLoading={null} onRecordIntake={() => {}} />,
    );
    expect(html).toContain("lucide-check");
    expect(html).toContain("lucide-skip-forward");
    expect(html).toContain("min-h-11");
  });

  it("state badges surface the without-notification + paused labels", () => {
    const html = render(
      <MedicationStateBadges
        notificationsEnabled={false}
        active={false}
        pausedAt="2026-05-01T08:00:00.000Z"
      />,
    );
    expect(html).toContain("Without notification");
    expect(html).toContain("Paused since");
  });
});

/**
 * Cross-variant streak-token parity: with a positive streak seeded, the
 * flame on BOTH the generic and the GLP-1 card resolves to the canonical
 * `text-dracula-orange`, and neither carries the legacy `text-orange-400`.
 */
describe("streak-token parity — generic vs GLP-1 card", () => {
  const ramipril = {
    id: "med-ramipril-streak",
    name: "Ramipril",
    dose: "5 mg",
    category: "BLOOD_PRESSURE",
    treatmentClass: undefined as string | undefined,
    active: true,
    notificationsEnabled: true,
    pausedAt: null,
    lastTakenAt: null,
    todayEventCount: 0,
    schedules: [
      {
        id: "s-ramipril-streak",
        windowStart: "00:00",
        windowEnd: "23:59",
        label: null,
        daysOfWeek: null,
        dose: "5 mg",
      },
    ],
  };

  const mounjaro: Glp1Medication = {
    id: "med-mounjaro-streak",
    name: "Mounjaro",
    dose: "7.5 mg",
    category: "HORMONE",
    treatmentClass: "GLP1",
    dosesPerUnit: 4,
    active: true,
    notificationsEnabled: true,
    pausedAt: null,
    lastTakenAt: null,
    todayEventCount: 0,
    schedules: [
      {
        id: "s-mounjaro-streak",
        windowStart: "00:00",
        windowEnd: "23:59",
        label: null,
        daysOfWeek: null,
        dose: "7.5 mg",
      },
    ],
  };

  function seedStreak(client: QueryClient, medId: string) {
    client.setQueryData(["medications", medId, "compliance"], {
      compliance7: { rate: 90, streak: 4, totalExpected: 7, taken: 6 },
      compliance30: { rate: 88 },
    });
  }

  it("both cards render the flame with the canonical token, never the drift", () => {
    const client = makeClient();
    seedStreak(client, ramipril.id);
    seedStreak(client, mounjaro.id);
    client.setQueryData(["medications", mounjaro.id, "glp1-details"], {
      doseChanges: [],
      recentIntakes: [],
      inventory: null,
    });

    const ramiprilHtml = render(
      <MedicationCard
        medication={ramipril}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
      />,
      client,
    );
    const mounjaroHtml = render(
      <Glp1MedicationCard
        medication={mounjaro}
        onEdit={() => {}}
        onOpenHistory={() => {}}
        onOpenAdvanced={() => {}}
      />,
      client,
    );

    for (const html of [ramiprilHtml, mounjaroHtml]) {
      expect(html).toContain("lucide-flame");
      expect(html).toContain("text-dracula-orange");
      expect(html).not.toContain("text-orange-400");
    }
  });
});
