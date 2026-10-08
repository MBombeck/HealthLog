"use client";

import { ShieldAlert, Users } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { AllergyManager } from "@/components/records/allergy-manager";
import { FamilyHistoryManager } from "@/components/records/family-history-manager";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.37.0 — Settings → Anamnese, inside somebody else's record.
 *
 * ## Why a second component instead of the personal one
 *
 * `AnamnesisSection` renders five managers, and only two of them belong to the
 * record. The other three write through `/api/coach/about-me` and
 * `/api/anamnesis/facts`, both of which resolve a bare `requireAuth()` and
 * therefore refuse outright under a switch. Mounting the personal section here
 * would put three forms on screen that answer 403 on submit — the precise
 * failure `useRecordCapabilities` was written to end ("a control that appeared
 * before its route answered"). So this surface is the intersection of the
 * section and what the record routes admit, and it is a separate component so
 * that intersection is visible rather than expressed as four conditionals
 * inside the personal one.
 *
 * ## What is here
 *
 * Allergies and family history. Both post to routes that resolve
 * `requireRecordAuth("manage", "profile")`, so both land under the record
 * owner with the delegate named as actor, and a READ or WRITE delegate is
 * refused by the route as well as never reaching this page.
 *
 * Family history is the one admitted write where third-party health
 * information is present by design — the row describes the record subject's
 * relatives, and often enough the delegate IS that relative, asserting a
 * condition about themselves into somebody else's record. The route's own
 * comment named that discomfort and left it for the surface to say out loud,
 * because no route comment can. The sentence at the top of the card body,
 * above the list, is where it gets said.
 *
 * The cache is not a concern here and the reason is worth naming: switching
 * records clears the whole query client, so the allergy and family-history
 * lists cannot carry one record's rows into another's view.
 */
export function RecordAnamnesisSection() {
  const { t } = useTranslations();

  return (
    <div className="space-y-6" data-slot="record-anamnesis-section">
      <SettingsCard>
        <SettingsCardHeader
          icon={ShieldAlert}
          title={t("records.allergies.cardTitle")}
          description={t("records.allergies.cardDescription")}
        />
        <AllergyManager />
      </SettingsCard>

      <SettingsCard>
        <SettingsCardHeader
          icon={Users}
          title={t("records.family.cardTitle")}
          description={t("records.family.cardDescription")}
        />
        {/* Above the list: the manager closes with its action row, and
            nothing follows a card's actions (design standards §12). */}
        <p
          data-slot="record-anamnesis-relative-note"
          className="text-foreground text-sm"
        >
          {t("recordSharing.anamnesis.relativeNote")}
        </p>
        <FamilyHistoryManager />
      </SettingsCard>

      <p className="text-muted-foreground text-xs">{t("records.disclaimer")}</p>
    </div>
  );
}
