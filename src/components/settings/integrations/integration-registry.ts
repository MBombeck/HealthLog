"use client";

/**
 * What the integrations list knows about each integration besides its status:
 * the icon, the name and the one line that says what it brings (a source) or
 * where it delivers (a channel). The status itself comes from the server
 * (`GET /api/integrations/overview`, read by the section) and is never
 * derived here.
 */
import {
  Activity,
  Archive,
  Bell,
  BellRing,
  Bike,
  CircleDot,
  CloudDownload,
  Droplet,
  HeartPulse,
  Mail,
  MapPin,
  MessageCircle,
  Scale,
  Smartphone,
  Watch,
  Webhook,
  type LucideIcon,
} from "lucide-react";

import type {
  IntegrationOverviewItem,
  OverviewKey,
  OverviewReason,
} from "@/lib/integrations/overview";

export const INTEGRATION_ICON: Record<OverviewKey, LucideIcon> = {
  "apple-health": HeartPulse,
  "health-connect-app": Smartphone,
  withings: Scale,
  whoop: Activity,
  "google-health": Watch,
  garmin: Watch,
  oura: CircleDot,
  polar: Watch,
  strava: Bike,
  nightscout: Droplet,
  dawarich: MapPin,
  "health-connect-remote": CloudDownload,
  "document-sources": Archive,
  telegram: MessageCircle,
  ntfy: Bell,
  "web-push": BellRing,
  webhook: Webhook,
  email: Mail,
  apns: Smartphone,
};

/** The message key of each integration's name. */
export const INTEGRATION_NAME_KEY: Record<OverviewKey, string> = {
  "apple-health": "settings.appleHealth.title",
  "health-connect-app": "settings.healthConnectApp.name",
  withings: "settings.withings",
  whoop: "settings.whoop",
  "google-health": "settings.googleHealth",
  garmin: "settings.garmin",
  oura: "settings.oura",
  polar: "settings.polar",
  strava: "settings.strava",
  nightscout: "settings.nightscout",
  dawarich: "settings.dawarich",
  "health-connect-remote": "settings.healthConnectFolder.name",
  "document-sources": "settings.documentSources.title",
  telegram: "settings.telegram",
  ntfy: "settings.ntfy",
  "web-push": "settings.webPush",
  webhook: "settings.webhook",
  email: "settings.email",
  apns: "settings.integrationList.apns",
};

/** What a source brings in, or where a channel delivers: one short line. */
export const INTEGRATION_BRINGS_KEY: Record<OverviewKey, string> = {
  "apple-health": "settings.integrationList.brings.appleHealth",
  "health-connect-app": "settings.integrationList.brings.healthConnectApp",
  withings: "settings.integrationList.brings.withings",
  whoop: "settings.integrationList.brings.whoop",
  "google-health": "settings.integrationList.brings.googleHealth",
  garmin: "settings.integrationList.brings.garmin",
  oura: "settings.integrationList.brings.oura",
  polar: "settings.integrationList.brings.polar",
  strava: "settings.integrationList.brings.strava",
  nightscout: "settings.integrationList.brings.nightscout",
  dawarich: "settings.integrationList.brings.dawarich",
  "health-connect-remote":
    "settings.integrationList.brings.healthConnectFolder",
  "document-sources": "settings.integrationList.brings.documentSources",
  telegram: "settings.integrationList.brings.telegram",
  ntfy: "settings.integrationList.brings.ntfy",
  "web-push": "settings.integrationList.brings.webPush",
  webhook: "settings.integrationList.brings.webhook",
  email: "settings.integrationList.brings.email",
  apns: "settings.integrationList.brings.apns",
};

/** The short reason under a name, one per server reason code. */
export const INTEGRATION_REASON_KEY: Record<OverviewReason, string> = {
  data_arriving: "settings.integrationList.reason.dataArriving",
  first_sync_pending: "settings.integrationList.reason.firstSyncPending",
  plan_limited: "settings.integrationList.reason.planLimited",
  permission_limited: "settings.integrationList.reason.permissionLimited",
  provider_errors: "settings.integrationList.reason.providerErrors",
  sync_stalled: "settings.integrationList.reason.syncStalled",
  no_new_data: "settings.integrationList.reason.noNewData",
  unexpected_silence: "settings.integrationList.reason.unexpectedSilence",
  reauth_required: "settings.integrationList.reason.reauthRequired",
  paused_after_errors: "settings.integrationList.reason.pausedAfterErrors",
  not_connected: "settings.integrationList.reason.notConnected",
  paused: "settings.integrationList.reason.paused",
  switched_off: "settings.integrationList.reason.switchedOff",
  auto_disabled: "settings.integrationList.reason.autoDisabled",
  sending_paused: "settings.integrationList.reason.sendingPaused",
  delivery_failing: "settings.integrationList.reason.deliveryFailing",
};

/** Older anchors that name a card the sheet of another key now holds. */
export const INTEGRATION_HASH_ALIASES: Readonly<Record<string, OverviewKey>> = {
  "nutrient-intake": "apple-health",
  "import-health-connect-remote": "health-connect-remote",
};

/**
 * The integration an anchor names (`/settings/integrations#oura`, a
 * SYNC_STALLED notice's `#<source>`, a palette entry), if the list has it.
 */
export function overviewKeyFromHash(
  hash: string,
  items: readonly IntegrationOverviewItem[],
): OverviewKey | null {
  const raw = hash.replace(/^#/, "");
  const id = INTEGRATION_HASH_ALIASES[raw] ?? raw;
  return items.find((item) => item.key === id)?.key ?? null;
}
