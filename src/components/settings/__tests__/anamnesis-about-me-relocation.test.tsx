import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { I18nProvider } from "@/lib/i18n/context";
import { AnamnesisSection } from "../anamnesis-section";

/**
 * #159 — the "About me" note and the free-text allergies line moved from the
 * account settings into the Anamnese. Two halves, and both matter:
 *
 *   1. PRESENCE — the Anamnese renders the note as its own card and mounts
 *      the free-text allergy supplement in the SAME card as the structured
 *      AllergyManager, directly under it.
 *   2. ABSENCE — the account section carries no about-me mount any more. The
 *      section is too prop- and hook-heavy for an SSR render here, so the
 *      absence half is structural over the source (the established
 *      `destructive-controls-confirm.test.tsx` pattern): no import, no
 *      element, no about-me slot.
 */

const moduleState = vi.hoisted(() => ({
  coach: true,
  insights: true,
}));

vi.mock("@/hooks/use-module-enabled", () => ({
  useModuleEnabled: (key: "coach" | "insights") => moduleState[key],
}));
vi.mock("@/components/records/ai-profile-inclusion-manager", () => ({
  AiProfileInclusionManager: () => null,
}));
vi.mock("@/components/records/conditions-manager", () => ({
  ConditionsManager: () => null,
}));
vi.mock("@/components/records/health-profile-facts-manager", () => ({
  HealthProfileFactsManager: () => null,
}));
vi.mock("@/components/records/allergy-manager", () => ({
  AllergyManager: ({
    afterList,
  }: {
    afterList?: (add: React.ReactNode) => React.ReactNode;
  }) => (
    <div data-slot="allergy-manager-probe">
      {afterList ? (
        afterList(<button data-slot="allergy-add-probe" />)
      ) : (
        <div data-slot="allergy-manager-own-actions" />
      )}
    </div>
  ),
}));
vi.mock("@/components/records/allergy-free-text-note", () => ({
  AllergyFreeTextNote: ({
    leadingAction,
  }: {
    leadingAction?: React.ReactNode;
  }) => (
    <div data-slot="allergy-free-text-probe">
      <div data-slot="settings-card-actions">{leadingAction}</div>
    </div>
  ),
}));
vi.mock("@/components/records/about-me-note-manager", () => ({
  AboutMeNoteManager: () => <div data-slot="about-me-note-probe" />,
}));
vi.mock("@/components/records/family-history-manager", () => ({
  FamilyHistoryManager: () => null,
}));
vi.mock("@/components/records/emergency-profile-manager", () => ({
  EmergencyProfileManager: () => null,
}));

function renderSection(): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <AnamnesisSection />
    </I18nProvider>,
  );
}

beforeEach(() => {
  moduleState.coach = true;
  moduleState.insights = true;
});

describe("Anamnese — the About-me note card (#159)", () => {
  it("renders the note as its own card in the medical history", () => {
    const html = renderSection();
    expect(html).toContain('data-testid="records-about-me-card"');
    expect(html).toContain('data-slot="about-me-note-probe"');
    expect(html).toContain("About me");
  });

  it("mounts the free-text allergy supplement in the allergies card, under the structured list", () => {
    const html = renderSection();
    const managerAt = html.indexOf('data-slot="allergy-manager-probe"');
    const noteAt = html.indexOf('data-slot="allergy-free-text-probe"');
    expect(managerAt).toBeGreaterThan(-1);
    expect(noteAt).toBeGreaterThan(-1);
    // Directly under the structured list, same card: the supplement follows
    // the manager, and no card boundary (a new SettingsCard opens with its
    // header h2) sits between the two.
    expect(noteAt).toBeGreaterThan(managerAt);
    const between = html.slice(managerAt, noteAt);
    expect(between).not.toContain("<h2");
  });

  it("ends the allergies card in one action row carrying the add action", () => {
    // The list's add button rides the note's row (design standards §12):
    // the manager renders no row of its own, and the note's row holds add.
    const html = renderSection();
    expect(html).not.toContain('data-slot="allergy-manager-own-actions"');
    const note = html.slice(
      html.indexOf('data-slot="allergy-free-text-probe"'),
    );
    expect(note).toMatch(
      /data-slot="settings-card-actions"><button data-slot="allergy-add-probe"/,
    );
  });

  it("keeps the same AI-surface gate as the inclusion card", () => {
    moduleState.coach = false;
    moduleState.insights = false;
    const html = renderSection();
    expect(html).not.toContain('data-testid="records-about-me-card"');
    // The allergy supplement is NOT AI-gated — the line is medical history
    // whichever surfaces read it, exactly like the structured list.
    expect(html).toContain('data-slot="allergy-free-text-probe"');
  });

  it("insights alone keeps the note available (the daily briefing reads it)", () => {
    moduleState.coach = false;
    const html = renderSection();
    expect(html).toContain('data-testid="records-about-me-card"');
  });
});

describe("Account settings — the About-me card is gone (#159)", () => {
  it("the account section carries no about-me mount any more", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/settings/account-section/index.tsx"),
      "utf8",
    );
    expect(source).not.toContain("AboutMeSection");
    expect(source).not.toContain("about-me-section");
    expect(source).not.toContain("AboutMeNoteManager");
    expect(source).not.toContain('data-testid="settings-about-me-card"');
  });
});
