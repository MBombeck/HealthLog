"use client";

import { useMemo } from "react";

import {
  CAPTURE_KIND_ORDER,
  visibleCaptureKinds,
} from "@/components/layout/capture-picker";
import { useAiCapability } from "@/hooks/use-ai-capability";
import { useAuth } from "@/hooks/use-auth";
import { useModuleEnabledState } from "@/hooks/use-module-toggle";
import { useNavModules } from "@/hooks/use-nav-modules";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import {
  buildPaletteIndex,
  type PaletteEntry,
} from "@/lib/command-palette/build-index";
import { useTranslations } from "@/lib/i18n/context";
import {
  MODULE_REGISTRY,
  isCodeDisabledModule,
  moduleDelegatesTo,
  type ModuleKey,
} from "@/lib/modules/registry";
import { isSettingsDestinationListedForRecord } from "@/lib/record-settings/classification";

/**
 * The palette's index for this session, read from the account payload the
 * shell already holds. See `buildPaletteIndex` for what is offered when.
 */
export function usePaletteIndex(): PaletteEntry[] {
  const { t } = useTranslations();
  const { user } = useAuth();
  const navModules = useNavModules();
  const capabilities = useRecordCapabilities();
  const { inSharedRecord, sections, recordKind, level } = capabilities;
  const coach = useAiCapability("coach");
  const isEnabled = useModuleEnabledState();
  const manageableDomains = user?.accountAccess?.active?.manageableDomains;
  const moduleAvailability = user?.moduleAvailability;
  const canCapture =
    visibleCaptureKinds(capabilities, CAPTURE_KIND_ORDER, user?.modules)
      .length > 0;

  // A module the operator switched off cannot be switched on by the person,
  // so it is not offered as a switch (Settings → Modules explains why).
  const moduleToggles = inSharedRecord
    ? []
    : (Object.keys(MODULE_REGISTRY) as ModuleKey[])
        .filter((key) => !isCodeDisabledModule(key))
        .filter((key) =>
          moduleDelegatesTo(key) === "coach"
            ? coach.reason !== "operator_disabled"
            : moduleAvailability?.[key] !== false,
        )
        .map((key) => ({ key, enabled: isEnabled(key) }));
  const togglesKey = moduleToggles
    .map((m) => `${m.key}:${m.enabled ? 1 : 0}`)
    .join(",");

  return useMemo(
    () =>
      buildPaletteIndex({
        t,
        modules: user?.modules,
        navModules,
        inSharedRecord,
        sections,
        isAdmin: user?.role === "ADMIN",
        settingsListed: inSharedRecord
          ? (slug) =>
              isSettingsDestinationListedForRecord(slug, {
                recordKind,
                level,
                manageableDomains: manageableDomains ?? [],
              })
          : () => true,
        canCapture,
        moduleToggles,
      }),
    // `moduleToggles` is rebuilt every render; its content is `togglesKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      t,
      user?.modules,
      user?.role,
      navModules,
      inSharedRecord,
      sections,
      recordKind,
      level,
      manageableDomains,
      canCapture,
      togglesKey,
    ],
  );
}
