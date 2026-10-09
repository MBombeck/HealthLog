"use client";

/**
 * v1.25 (W-RECORDS) — Settings → Anamnese (medical history).
 *
 * The home for the structured health records: allergies / intolerances and
 * family history. Each is a self-contained CRUD manager rendered in its own
 * card. These are patient-reported reference records — not a time-series
 * signal and not a clinical diagnosis — surfaced alongside the existing
 * tracking-domain settings sections (Labs / Illness / Vorsorge).
 *
 * v1.25.12 — the section is the single home for the pre-existing / chronic
 * conditions the Coach watches, edited inline here so conditions + allergies +
 * family history read (and write) as one coherent medical history. The
 * conditions card is coach-gated (the data only feeds the Coach); it reads and
 * writes the same self-context store (`/api/coach/about-me`) the rest of the app
 * uses — the placement simply moved out of personal context into the medical
 * record where it belongs.
 */

import {
  ClipboardList,
  EyeOff,
  HeartPulse,
  NotebookPen,
  ShieldAlert,
  Siren,
  Users,
} from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { useModuleEnabled } from "@/hooks/use-module-enabled";

import { AllergyManager } from "@/components/records/allergy-manager";
import { AllergyFreeTextNote } from "@/components/records/allergy-free-text-note";
import { AboutMeNoteManager } from "@/components/records/about-me-note-manager";
import { ConditionsManager } from "@/components/records/conditions-manager";
import { EmergencyProfileManager } from "@/components/records/emergency-profile-manager";
import { FamilyHistoryManager } from "@/components/records/family-history-manager";
import { AiProfileInclusionManager } from "@/components/records/ai-profile-inclusion-manager";
import { HealthProfileFactsManager } from "@/components/records/health-profile-facts-manager";

export function AnamnesisSection() {
  const { t } = useTranslations();
  // The inclusion card and the about-me note only feed AI surfaces, so they
  // follow the person's two AI opt-outs: the Coach module and "AI analysis"
  // (the `insights` module, which since v1.39 governs model-written text and
  // nothing else). They are opt-outs, not capabilities, on purpose: somebody
  // without a provider yet can still write the note the AI will read later.
  const coachEnabled = useModuleEnabled("coach");
  const insightsEnabled = useModuleEnabled("insights");
  return (
    <div className="space-y-6">
      {(coachEnabled || insightsEnabled) && (
        <SettingsCard>
          <SettingsCardHeader
            anchor="ai-inclusion"
            icon={EyeOff}
            title={t("records.aiInclusion.cardTitle")}
            description={t("records.aiInclusion.cardDescription")}
          />
          <AiProfileInclusionManager />
        </SettingsCard>
      )}

      {coachEnabled && (
        <SettingsCard>
          <SettingsCardHeader
            anchor="conditions"
            icon={HeartPulse}
            title={t("records.conditions.cardTitle")}
            description={t("records.conditions.cardDescription")}
          />
          <ConditionsManager />
        </SettingsCard>
      )}

      {/* #159 — the "About me" free-text note moved here from the account
          settings: it is personal medical context the Coach and the daily
          briefing read, so it belongs in the medical history. Same
          AI-surface gate as the inclusion card above — the note only feeds
          the AI surfaces, so with both disabled there is nothing to feed. */}
      {(coachEnabled || insightsEnabled) && (
        <SettingsCard
          as="section"
          aria-labelledby="records-about-me-title"
          data-testid="records-about-me-card"
        >
          <SettingsCardHeader
            anchor="about-me"
            icon={NotebookPen}
            title={t("settings.ai.aboutMe.title")}
            titleId="records-about-me-title"
            description={t("settings.ai.aboutMe.description")}
          />
          <AboutMeNoteManager />
        </SettingsCard>
      )}

      <SettingsCard>
        <SettingsCardHeader
          anchor="profile-facts"
          icon={ClipboardList}
          title={t("records.profileFacts.cardTitle")}
          description={t("records.profileFacts.cardDescription")}
        />
        <HealthProfileFactsManager />
      </SettingsCard>

      <SettingsCard>
        <SettingsCardHeader
          anchor="allergies"
          icon={ShieldAlert}
          title={t("records.allergies.cardTitle")}
          description={t("records.allergies.cardDescription")}
        />
        {/* #159 — the free-text supplement to the structured list above,
            moved here from the account-settings "About me" panel so both
            allergy inputs live in one card. The list's add button rides the
            note's action row, so the card ends in one row. */}
        <AllergyManager
          afterList={(add) => <AllergyFreeTextNote leadingAction={add} />}
        />
      </SettingsCard>

      <SettingsCard>
        <SettingsCardHeader
          anchor="family-history"
          icon={Users}
          title={t("records.family.cardTitle")}
          description={t("records.family.cardDescription")}
        />
        <FamilyHistoryManager />
      </SettingsCard>

      <SettingsCard>
        <SettingsCardHeader
          anchor="emergency"
          icon={Siren}
          title={t("records.emergency.cardTitle")}
          description={t("records.emergency.cardDescription")}
        />
        <EmergencyProfileManager />
      </SettingsCard>

      <p className="text-muted-foreground text-xs">{t("records.disclaimer")}</p>
    </div>
  );
}
