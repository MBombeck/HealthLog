"use client";

import { useState } from "react";
import Link from "next/link";
import { Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { useAiProviderState } from "@/hooks/use-ai-capability";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { hasOptedOutOfAi } from "@/lib/ai/capabilities/types";
import { useTranslations } from "@/lib/i18n/context";

/**
 * The one place HealthLog mentions that AI could be set up.
 *
 * HealthLog works without AI, so a missing provider is not a problem to
 * report on every card. The per-card "connect an AI provider" states are
 * gone; this calm hint replaces them, on the Insights overview and in
 * Settings → AI, and nowhere else.
 *
 * It shows only while no provider is configured AND the person could set one
 * up here (`provider.canConfigure`: false inside somebody else's record and
 * while the operator has AI switched off, where the hint would point at a
 * setting nobody on this screen can change) AND they have not switched both
 * the Coach and AI analysis off (`hasOptedOutOfAi`). Dismissing it is
 * remembered per viewer in this browser; the hint stays gone on both surfaces.
 */
const AI_SETUP_HINT_STORAGE_PREFIX = "healthlog.ai-setup-hint.dismissed";

function storageKey(viewerId: string): string {
  return `${AI_SETUP_HINT_STORAGE_PREFIX}.${viewerId}`;
}

function readDismissed(viewerId: string): boolean {
  try {
    return window.localStorage.getItem(storageKey(viewerId)) === "1";
  } catch {
    return false;
  }
}

export function AiSetupHint({
  surface = "insights",
}: {
  /**
   * `insights`: a tile on the overview with a link to Settings → AI.
   * `settings`: a Settings card on Settings → AI itself, with no link.
   */
  surface?: "insights" | "settings";
}) {
  const { t } = useTranslations();
  const { user } = useAuth();
  const provider = useAiProviderState();
  // Storage is browser-only: nothing renders before hydration, so the server
  // HTML and the first client render agree.
  const mounted = useMounted();
  const [dismissedNow, setDismissedNow] = useState(false);

  const viewerId = user?.id ?? null;
  if (!mounted || viewerId === null) return null;
  if (provider.configured || !provider.canConfigure) return null;
  if (hasOptedOutOfAi(user?.modules)) return null;
  if (dismissedNow || readDismissed(viewerId)) return null;

  const dismiss = () => {
    setDismissedNow(true);
    try {
      window.localStorage.setItem(storageKey(viewerId), "1");
    } catch {
      // Storage unavailable (private mode): hidden for this visit only.
    }
  };

  if (surface === "settings") {
    return (
      <SettingsCard data-slot="ai-setup-hint">
        <SettingsCardHeader
          icon={Sparkles}
          title={t("insights.aiSetupHint.title")}
        />
        <p className="text-foreground text-sm">
          {t("insights.aiSetupHint.settingsBody")}
        </p>
        <SettingsCardActions>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            onClick={dismiss}
            data-slot="ai-setup-hint-dismiss"
          >
            {t("insights.aiSetupHint.dismiss")}
          </Button>
        </SettingsCardActions>
      </SettingsCard>
    );
  }

  return (
    <Card data-slot="ai-setup-hint" density="compact">
      <CardHeader>
        <TileHeader
          icon={Sparkles}
          title={t("insights.aiSetupHint.title")}
          right={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={dismiss}
              aria-label={t("insights.aiSetupHint.dismiss")}
              title={t("insights.aiSetupHint.dismiss")}
              data-slot="ai-setup-hint-dismiss"
              // 44 px on a phone like every other mobile action; the negative
              // margin keeps the header row as tall as the title needs.
              className="-my-2.5 size-11 shrink-0 sm:-my-2 sm:size-10"
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          }
        />
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-3">
        <p className="text-foreground text-sm">
          {t("insights.aiSetupHint.body")}
        </p>
        <Button
          asChild
          size="sm"
          variant="outline"
          className="min-h-11 sm:min-h-9"
        >
          <Link href="/settings/ai" data-slot="ai-setup-hint-link">
            {t("insights.aiSetupHint.action")}
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
