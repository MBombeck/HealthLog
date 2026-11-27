"use client";

/**
 * `<IntegrationsSection>` — Settings → Integrationen.
 *
 * v1.18.1 — the Connections content IS the Integrationen page: clicking
 * Integrationen shows the OAuth + device data sources (Withings / WHOOP /
 * Google Health / Polar / Oura / Nightscout) directly, with no tab strip.
 *
 * v1.25.7 — the delivery CHANNELS (Telegram / ntfy / Web Push / Webhook /
 * Email) move back here from Notifications as a labelled "Delivery channels"
 * group below the connections. Channels are delivery providers — the same
 * conceptual family as Withings / WHOOP / a connected device — not reminder
 * preferences, so they belong with the other integrations. Notifications keeps
 * only the reminder-TYPE content. The group carries `id="channels"` so
 * `/settings/channels` 301-redirects to `/settings/integrations#channels`, and
 * the per-channel anchors (`#telegram`, `#ntfy`, …) inside the panel keep
 * working.
 *
 * `parseOAuthOutcome` / `oauthReasonKey` are re-exported from
 * `connections-panel.tsx` so existing unit-test imports keep resolving.
 *
 * `<NutrientIntakeCard>` (v1.28) moved here from
 * Settings → Sources. It is a read-only sync inventory (what the Apple
 * Health nutrients opt-in has stored), not a which-connection-wins ranking —
 * "Source priority" describes the latter only. Matches the standing
 * providers→Integrations rule; the card still renders nothing while the
 * `nutrients` module is off.
 */

import Link from "next/link";
import { Link2, Send } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import type { IntegrationCallbackUrls } from "@/lib/integrations/callback-urls";
import { ConnectionsPanel } from "@/components/settings/integrations/connections-panel";
import { SectionHeading } from "@/components/ui/section-heading";
import { NotificationChannelsPanel } from "@/components/settings/integrations/notification-channels-panel";
import { NutrientIntakeCard } from "@/components/settings/nutrient-intake-card";
import { DocumentSourcesCard } from "@/components/settings/integrations/document-sources-card";
import { Button } from "@/components/ui/button";

export {
  parseOAuthOutcome,
  oauthReasonKey,
} from "@/components/settings/integrations/connections-panel";

export function IntegrationsSection({
  callbackUrls,
}: {
  /** Server-resolved per-provider OAuth callback URLs; see `ConnectionsPanel`. */
  callbackUrls: IntegrationCallbackUrls;
}) {
  const { t } = useTranslations();

  // v1.18.6 — the visible page heading + subtitle come from the shared
  // `<SettingsSectionFrame>` in the route; the connections panel is the
  // primary surface, with the delivery-channels group sequenced below it.
  return (
    <div className="space-y-10">
      {/* Connections ("where the data comes from"). The OAuth + device data
          sources. A labelled group header gives this block parity with the
          delivery-channels group below it. */}
      <section className="space-y-4">
        <SectionHeading
          icon={Link2}
          title={t("settings.sections.integrations.connectionsHeading")}
          // The module tour's "integrations" stop anchors here.
          tourId="integrations-hero"
        />
        <ConnectionsPanel callbackUrls={callbackUrls} />

        {/* The opt-in nutrients sync inventory
            (moved from Settings → Sources, where "source priority" only
            ever meant which-connection-wins ranking, not a read-only sync
            list). The card carries its own header + renders nothing while
            the `nutrients` module is off, so it slots in as a sibling card
            under the same Connections group rather than a new labelled
            section that could paint an orphaned heading over nothing. */}
        <NutrientIntakeCard />

        {/* v1.39.3 (#1038) — Paperless-ngx / Papra for the document picker.
            Renders nothing unless the operator listed an origin in
            DOCUMENT_SOURCE_ORIGINS and the person is in their own record. */}
        <DocumentSourcesCard />
      </section>

      {/* Delivery channels ("where it's delivered"). The existing channels
          panel, unchanged. `id="channels"` anchors the group for the
          `/settings/channels` redirect; the per-channel anchors stay inside
          the panel. */}
      <section id="channels" className="scroll-mt-28 space-y-4">
        {/* The link names the per-event notification matrix so the three
            notification surfaces (matrix, reminder types, channels)
            cross-reference; it stands on the right of the group heading. */}
        <SectionHeading
          icon={Send}
          title={t("settings.sections.integrations.channelsHeading")}
          action={
            <Button
              asChild
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-9"
            >
              <Link href="/notifications">
                {t("settings.sections.integrations.matrixLink")}
              </Link>
            </Button>
          }
        />
        <NotificationChannelsPanel />
      </section>
    </div>
  );
}
