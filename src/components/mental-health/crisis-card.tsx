"use client";

/**
 * v1.25.3 — the calm, non-alarmist crisis-resource card.
 *
 * Shared between the fresh-result view (the POST response carries the crisis
 * set on any non-zero PHQ-9 item 9) and the history list, where tapping a
 * flagged row re-surfaces this card from the STATIC, locale-derived resource
 * config (`crisisResourcesForLocale`) — it NEVER decrypts or reveals the
 * item-9 answer, and showing it never triggers any third-party alert.
 *
 * Tone follows the v1.25.1 decision: a calm `border-destructive/40` border,
 * never an amber/red fill; the `role="alert"` + `aria-live` carry the urgency.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslations } from "@/lib/i18n/context";

import type { CrisisSet } from "./types";

export function CrisisCard({ crisis }: { crisis: CrisisSet }) {
  const { t } = useTranslations();
  return (
    <Card
      className="border-destructive/40"
      role="alert"
      aria-live="assertive"
      data-slot="mental-health-crisis-card"
    >
      <CardHeader>
        <CardTitle className="text-base">
          {t("mentalHealth.crisis.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <p>{t("mentalHealth.crisis.intro")}</p>
        <p className="font-medium">
          {t("mentalHealth.crisis.ifDanger", {
            emergency: crisis.emergencyNumber,
          })}
        </p>
        <div className="flex flex-col gap-2">
          <span className="text-muted-foreground text-xs font-medium">
            {t("mentalHealth.crisis.resourcesTitle")}
          </span>
          <ul className="flex flex-col gap-2">
            {crisis.resources.map((r) => (
              <li key={r.id} className="flex flex-col">
                <span className="font-medium">
                  {t(`mentalHealth.crisisResource.${r.id}.name`)}
                </span>
                <span className="text-muted-foreground">
                  {r.contacts.join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
