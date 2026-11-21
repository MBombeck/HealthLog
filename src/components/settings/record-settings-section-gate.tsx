"use client";

import type { ComponentType, ReactNode } from "react";
import dynamic from "next/dynamic";
import { CircleSlash, Loader2 } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useTranslations } from "@/lib/i18n/context";
import { classifySettingsDestination } from "@/lib/record-settings/classification";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { ManagedIntegrationStatus } from "@/components/settings/managed-integration-status";
import { SettingsCard } from "@/components/settings/settings-card";
import type { SettingsSectionSlug } from "@/lib/settings/section-slugs";
import type { ManagedRecordSettingsFamily } from "@/lib/record-settings/configuration";

type ManagedSettingsFamily = ManagedRecordSettingsFamily;

// The two record-scoped surfaces load on demand. Both are forms that validate
// with Zod (the managed settings patch, the allergy and family-history
// entries), and every settings page renders this gate, so importing them
// statically put Zod into the first load of every section for a branch that
// only a shared or managed record ever reaches. The classifier is imported
// from its leaf for the same reason: the `@/lib/record-settings` barrel also
// re-exports the settings-patch schemas.
const ManagedRecordSettingsSection = dynamic(() =>
  import("@/components/settings/managed-record-settings-section").then(
    (m) => m.ManagedRecordSettingsSection,
  ),
);
const RecordAnamnesisSection = dynamic(() =>
  import("@/components/settings/record-anamnesis-section").then(
    (m) => m.RecordAnamnesisSection,
  ),
);

/**
 * The record-CONTENT destinations, and what each one renders inside a record.
 *
 * Keyed by slug so the branch below asks which page it is on rather than which
 * category the page belongs to. Every `manage-writable` slug must have an
 * entry and nothing else may: the contract test holds both directions, which
 * is what stops a new destination inheriting this one's forms.
 */
export const RECORD_CONTENT_SECTIONS: Partial<
  Record<SettingsSectionSlug, ComponentType>
> = {
  anamnesis: RecordAnamnesisSection,
};

const MANAGED_RECORD_SETTINGS_FAMILY_BY_SECTION = {
  account: "profile",
  modules: "modules",
  notifications: "notifications",
  thresholds: "thresholds",
  coach: "coach",
  // #1403 — the AI page carries the owner's automatic-reading switch; inside
  // a managed profile it carries the profile's, below the profile's provider
  // source.
  ai: ["aiSource", "documents"],
} as const;

/**
 * Stops actor-scoped Settings components from mounting while the browser is
 * switched into another record. The only managed integration surface is its
 * status projection; all other direct links resolve to a local refusal state.
 */
export function RecordSettingsSectionGate({
  section,
  children,
}: {
  section: SettingsSectionSlug;
  children: ReactNode;
}) {
  const { isLoading } = useAuth();
  const { inSharedRecord, recordKind, level } = useRecordCapabilities();
  const { t } = useTranslations();

  // A shared session must never begin by mounting the actor's Settings
  // component and withdraw it when `/api/auth/me` resolves. The shell holds
  // Settings during auth resolution too; this branch keeps direct route use
  // equally safe when the gate is rendered independently in a test or story.
  if (isLoading) {
    return (
      <SettingsCard aria-busy="true" role="status">
        <SettingsCardHeader icon={Loader2} title={t("nav.loadingScreen")} />
      </SettingsCard>
    );
  }

  if (!inSharedRecord) return children;

  const destination = classifySettingsDestination(section);

  // v1.37.0 — the one destination that is record CONTENT rather than record
  // configuration, and therefore the one every MANAGE holder reaches: a
  // Guardian inside the profile they administer, and an adult delegate whose
  // grant is MANAGE. Both post to routes that already resolve
  // `requireRecordAuth("manage", "profile")`; before this the forms had no
  // reachable page and the permission had no caller.
  //
  // Checked before the managed branches so a Guardian gets the same record
  // surface an adult manager does, rather than the guardian configuration
  // panel, which has no family for it.
  //
  // Resolved through a slug map rather than by matching the kind, and that is
  // not belt-and-braces. `manage-writable` is a classification, not a
  // component: a second destination joining it — a future record-content page
  // — would otherwise render the allergy and family-history managers under its
  // own heading, silently, because the branch matched a category where a page
  // was meant. `RECORD_CONTENT_SECTIONS` says which page each slug is, a slug
  // with no entry falls through to the refusal panel below, and
  // `record-settings-contract.test.ts` fails if the map and the classification
  // ever disagree — so a destination cannot join the kind without somebody
  // deciding what it renders.
  const RecordContent =
    level === "manage" && destination.kind === "manage-writable"
      ? RECORD_CONTENT_SECTIONS[section]
      : undefined;
  if (RecordContent) return <RecordContent />;

  if (
    recordKind === "managed" &&
    destination.kind === "managed-guardian" &&
    section === "integrations"
  ) {
    return <ManagedIntegrationStatus />;
  }

  if (
    recordKind === "managed" &&
    destination.kind === "managed-guardian" &&
    section in MANAGED_RECORD_SETTINGS_FAMILY_BY_SECTION
  ) {
    const mapped: string | readonly string[] =
      MANAGED_RECORD_SETTINGS_FAMILY_BY_SECTION[
        section as keyof typeof MANAGED_RECORD_SETTINGS_FAMILY_BY_SECTION
      ];
    const families = (
      typeof mapped === "string" ? [mapped] : mapped
    ) as readonly ManagedSettingsFamily[];
    return (
      <div className="space-y-6">
        {families.map((family) => (
          <ManagedRecordSettingsSection key={family} family={family} />
        ))}
      </div>
    );
  }

  return (
    <SettingsCard aria-labelledby="shared-record-settings-unavailable-title">
      <SettingsCardHeader
        icon={CircleSlash}
        title={t("settings.sharedRecord.unavailableTitle")}
        titleId="shared-record-settings-unavailable-title"
        description={t("settings.sharedRecord.unavailableDescription")}
      />
    </SettingsCard>
  );
}
