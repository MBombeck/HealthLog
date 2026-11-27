"use client";

import { useState } from "react";
import { Loader2, ShieldCheck, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useAiConsent, useAiProviderState } from "@/hooks/use-ai-capability";
import { useAuth } from "@/hooks/use-auth";
import { useGrantAiConsent } from "@/hooks/use-grant-ai-consent";
import { useMounted } from "@/hooks/use-mounted";
import type { AiConsentState } from "@/lib/ai/capabilities/types";
import { useTranslations } from "@/lib/i18n/context";

/**
 * The consent question for AI on the operator's provider, asked once and
 * only where it opens something.
 *
 * Shown while `ai.consent.status` is `needed`: the provider chain runs
 * through a credential the operator holds (their API key or their shared
 * ChatGPT account) and some AI feature is closed by nothing but the missing
 * consent. The card says which service the data goes to (named by the server
 * in `ai.consent.recipients`), which data, that nothing goes there before the
 * person agrees, and that they can withdraw it. The one "Agree" button is the
 * consent act; nothing else on any surface mints a receipt.
 *
 * Two surfaces. In Settings → AI it is a settings card that stays until the
 * question is answered there. On the Insights overview, beside the setup
 * hint, it is a tile the person can put away; that is remembered per viewer
 * in this browser and does not count as an answer.
 */
const DISMISS_STORAGE_PREFIX = "healthlog.ai-consent-request.dismissed";

function readDismissed(viewerId: string): boolean {
  try {
    return (
      window.localStorage.getItem(`${DISMISS_STORAGE_PREFIX}.${viewerId}`) ===
      "1"
    );
  } catch {
    return false;
  }
}

/** The services the consent would cover, as one readable list. */
function recipientList(consent: AiConsentState): string {
  return consent.recipients.map((recipient) => recipient.name).join(", ");
}

export function AiConsentRequest({
  surface,
}: {
  /**
   * `settings`: a Settings card in Settings → AI.
   * `insights`: a dismissible tile on the Insights overview.
   */
  surface: "settings" | "insights";
}) {
  const { t } = useTranslations();
  const { user } = useAuth();
  const consent = useAiConsent();
  const provider = useAiProviderState();
  const grant = useGrantAiConsent();
  const mounted = useMounted();
  const [dismissedNow, setDismissedNow] = useState(false);

  const viewerId = user?.id ?? null;
  // Asked only of somebody who could set AI up for this record: not inside a
  // record somebody else owns, not while the operator has AI switched off.
  if (consent?.status !== "needed" || !provider.canConfigure) return null;
  if (viewerId === null) return null;

  const body = (
    <>
      <p className="text-foreground text-sm">
        {t("settings.ai.consent.request.body", {
          providers: recipientList(consent),
        })}
      </p>
      <p className="text-foreground text-sm">
        {t("settings.ai.consent.request.data")}
      </p>
      <p className="text-muted-foreground text-xs">
        {t("settings.ai.consent.request.withdrawHint")}
      </p>
      {grant.isError ? (
        <p className="text-destructive text-xs" role="alert">
          {t("settings.ai.consent.grantError")}
        </p>
      ) : null}
    </>
  );

  const agree = (
    <Button
      type="button"
      size="sm"
      className="min-h-11 sm:min-h-9"
      data-slot="ai-consent-request-agree"
      disabled={grant.isPending}
      onClick={() => grant.mutate()}
    >
      {grant.isPending ? (
        <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
      ) : null}
      {t("settings.ai.consent.request.agree")}
    </Button>
  );

  if (surface === "settings") {
    return (
      <SettingsCard as="section" data-slot="ai-consent-request">
        <SettingsCardHeader
          anchor="ai-consent"
          icon={ShieldCheck}
          title={t("settings.ai.consent.request.title")}
        />
        {body}
        <SettingsCardActions>{agree}</SettingsCardActions>
      </SettingsCard>
    );
  }

  // Storage is browser-only: nothing renders before hydration, so the server
  // HTML and the first client render agree.
  if (!mounted || dismissedNow || readDismissed(viewerId)) return null;
  const dismiss = () => {
    setDismissedNow(true);
    try {
      window.localStorage.setItem(`${DISMISS_STORAGE_PREFIX}.${viewerId}`, "1");
    } catch {
      // Storage unavailable (private mode): hidden for this visit only.
    }
  };

  return (
    <Card data-slot="ai-consent-request" density="compact">
      <CardHeader>
        <TileHeader
          icon={ShieldCheck}
          title={t("settings.ai.consent.request.title")}
          right={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={dismiss}
              aria-label={t("settings.ai.consent.request.dismiss")}
              title={t("settings.ai.consent.request.dismiss")}
              data-slot="ai-consent-request-dismiss"
              className="-my-2.5 size-11 shrink-0 sm:-my-2 sm:size-10"
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          }
        />
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-3">
        {body}
        {agree}
      </CardContent>
    </Card>
  );
}
