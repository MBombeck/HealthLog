"use client";

/**
 * The catch-all row — no envelope entry renders nowhere.
 *
 * A provider whose Settings card was removed kept its sync cron, its ledger
 * row and its block on the status envelope, and lost the only surface that
 * could have shown it dying. It then stopped syncing for a month and nothing,
 * anywhere, said so.
 *
 * This row closes the class rather than the instance: the connections panel
 * iterates the envelope and renders this for every configured entry no bespoke
 * card claims. Adding a provider to the envelope without a card now produces a
 * visible row instead of a silent JSON block, and a structural test pins that
 * nothing can go unrendered.
 *
 * Read-only by design. A deliberately dropped integration does not get its
 * management surface back; it gets an honest status.
 */

import { Plug } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";

import { IntegrationCard } from "./integration-card";
import type { IntegrationKey, IntegrationStatusViewModel } from "./shared";

/**
 * Display names, mirroring the server-side `INTEGRATION_LABELS`. Only the
 * card-less keys can ever reach this row, but the map stays complete so a
 * future drop needs no edit here.
 */
export const INTEGRATION_DISPLAY_NAMES: Record<IntegrationKey, string> = {
  withings: "Withings",
  whoop: "WHOOP",
  fitbit: "Fitbit",
  nightscout: "Nightscout",
  polar: "Polar",
  oura: "Oura",
  "google-health": "Google Health",
  strava: "Strava",
  dawarich: "Dawarich",
  garmin: "Garmin",
};

/**
 * The same card every integration renders, read-only: the server's health,
 * its sentence and its details, and no menu, because a dropped integration
 * does not get its management surface back.
 */
export function IntegrationFallbackRow({
  status,
}: {
  status: IntegrationStatusViewModel;
}) {
  const { t } = useTranslations();
  const name =
    INTEGRATION_DISPLAY_NAMES[status.integration] ?? status.integration;
  return (
    <IntegrationCard
      provider={status.integration}
      providerName={name}
      icon={Plug}
      description={t("settings.integrationFallback.description")}
      connected={(status.connected ?? status.configured) === true}
      health={status.health ?? null}
      testId="integration-fallback-row"
    />
  );
}
