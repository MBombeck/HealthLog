"use client";

/**
 * v1.17.1 — shared "Setup guide" doc-link for every Settings → Integrations
 * card. Each card paints the same affordance: one discreet, external link to
 * the provider's setup runbook ("was eingeben, wo klicken"). Single-sourced
 * here so all six cards (WHOOP / Withings / Fitbit / Polar / Oura / Nightscout)
 * read as one family and the docs host lives in exactly one place.
 *
 * The runbooks themselves are authored separately; this link wires the
 * destination now so a user who is mid-setup always knows where to go.
 */

import { useSyncExternalStore } from "react";
import { ExternalLink } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";

/**
 * The docs site's guides, where every provider runbook lives at
 * `connect-<provider>/`, e.g. `https://docs.healthlog.dev/guides/connect-whoop/`.
 * These are the pages themselves: the older `/integrations/<provider>` paths
 * only resolve through redirects. Kept as a single constant so the host never
 * drifts across cards.
 */
export const DOCS_GUIDES_BASE = "https://docs.healthlog.dev/guides";

/** Garmin has no connector; the Google Health guide explains the route. */
export const GARMIN_DOCS_HREF = `${DOCS_GUIDES_BASE}/connect-google-health/#garmin-owners`;

export type IntegrationDocsProvider =
  | "whoop"
  | "withings"
  | "fitbit"
  | "polar"
  | "oura"
  | "nightscout"
  | "google-health"
  | "strava"
  | "dawarich";

export function integrationDocsHref(provider: IntegrationDocsProvider): string {
  return `${DOCS_GUIDES_BASE}/connect-${provider}/`;
}

/**
 * Shows a compact warning when the callback origin differs from the app.
 *
 * `callbackUrl` is the value the server registers as `redirect_uri`, resolved
 * per request by `getIntegrationCallbackUrls()` and passed down as a prop. It
 * must not be derived here: a `NEXT_PUBLIC_*` read in a client module is
 * inlined at build time, and the published image is built without it.
 * `null` means the provider cannot build a redirect URI from the current env,
 * so there is nothing to compare.
 */
export function CallbackMismatchNotice({
  provider,
  callbackUrl,
}: {
  provider: string;
  callbackUrl: string | null;
}) {
  // Get the current origin of the app
  const { t } = useTranslations();
  const currentOrigin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => null,
  );
  // Get the origin of the callback URL
  const callbackOrigin = (() => {
    if (!callbackUrl) return null;
    try {
      return new URL(callbackUrl).origin;
    } catch {
      return null;
    }
  })();
  if (!currentOrigin || !callbackOrigin || callbackOrigin === currentOrigin) {
    return null;
  }
  // If the callback origin differs from the app, show a warning
  return (
    <span className="text-warning border-warning/30 bg-warning/5 block rounded-md border px-2 py-1 text-xs">
      {t("settings.oauthCallbackPreflightItem", {
        provider,
        configuredOrigin: callbackOrigin,
        currentOrigin,
      })}
    </span>
  );
}

/**
 * v1.29.x (UX audit H2) — compact 3-step BYO-developer-app guide for the
 * six providers that require a self-hoster to register their own vendor
 * app before an OAuth connect can ever succeed (Withings / WHOOP / Fitbit /
 * Polar / Oura / Strava). The external "Setup guide" link explains the
 * *why*; this inline callout gives the one value every vendor form asks
 * for and the app already knows — the callback URL — so it doesn't have to
 * be reconstructed by hand from the docs. Shown only while the user hasn't
 * saved their own credentials yet; it steps out of the way once configured.
 */
export function IntegrationRedirectGuide({
  provider,
  providerLabel,
  callbackUrl,
}: {
  provider: IntegrationDocsProvider;
  providerLabel: string;
  /**
   * The server-resolved callback URL (see `CallbackMismatchNotice`). When the
   * provider cannot build one from the current env, show the fixed path so
   * the step still names what the vendor form expects.
   */
  callbackUrl: string | null;
}) {
  const { t } = useTranslations();
  const shownCallbackUrl = callbackUrl ?? `/api/${provider}/callback`;
  return (
    <div
      className="bg-muted/40 border-border/60 space-y-1.5 rounded-md border p-3 text-xs"
      data-testid={`${provider}-redirect-guide`}
    >
      <p className="text-muted-foreground">
        {t("settings.integrationRedirectGuide.intro", {
          provider: providerLabel,
        })}
      </p>
      <ol className="text-muted-foreground list-decimal space-y-1 pl-4">
        <li>
          {t("settings.integrationRedirectGuide.step1", {
            provider: providerLabel,
          })}
        </li>
        <li>
          {t("settings.integrationRedirectGuide.step2")}{" "}
          <code
            className="bg-background text-foreground rounded px-1 py-0.5 font-mono break-all"
            data-testid={`${provider}-redirect-uri`}
          >
            {shownCallbackUrl}
          </code>
        </li>
        <li>{t("settings.integrationRedirectGuide.step3")}</li>
      </ol>
    </div>
  );
}

/**
 * The one description every integration card paints: ONE sentence, then the
 * setup-guide link inline at the end of it.
 *
 * It used to be two paragraphs stacked in the description slot — a white
 * primary sentence and a grey secondary one whose only job was to carry the
 * link. The secondary sentence was byte-identical across six of the eight
 * cards, which is the tell: it said nothing about the provider it sat under.
 * The link is the part that carried information, so the link is what stayed.
 */
export function IntegrationCardDescription({
  i18nPrefix,
  provider,
}: {
  i18nPrefix: string;
  provider: IntegrationDocsProvider;
}) {
  const { t } = useTranslations();
  return (
    <>
      {t(`${i18nPrefix}Description`)}{" "}
      <a
        href={integrationDocsHref(provider)}
        target="_blank"
        rel="noopener noreferrer"
        data-testid={`${provider}-setup-guide`}
        data-slot="integration-setup-guide"
        className="hover:text-foreground inline-flex items-center gap-1 underline underline-offset-2"
      >
        {t("settings.integrationSetupGuide")}
        <ExternalLink className="h-3 w-3" aria-hidden="true" />
      </a>
    </>
  );
}
