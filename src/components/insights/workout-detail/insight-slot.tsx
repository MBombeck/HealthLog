"use client";

import { Sparkles } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { useTranslations } from "@/lib/i18n/context";

/**
 * The per-workout Activity Insight card.
 *
 * Mounts only when the workout payload carries a paragraph — the page composes
 * `{aiInsight ? <WorkoutInsightCard insight={aiInsight}/> : null}`, and `null`
 * is the common case rather than an error state: a paragraph exists only for a
 * session that LANDED while the feature was live, ran over ten minutes, fell
 * under the day's cap, and found a provider. Every workout that predates the
 * feature, every re-synced one, and every one on a provider-less install
 * renders nothing here, permanently. Opening this page never generates one.
 *
 * Non-diagnostic by construction: a descriptive paragraph, device-attributed,
 * compared only to the user's own history, never a verdict and never a training
 * prescription (the contract lives in `@/lib/ai/prompts/workout-insight`).
 *
 * The paragraph renders as React TEXT CHILDREN, deliberately. There is no
 * markdown library in this project and adding one is a security decision, not a
 * formatting one — model output rendered as markup is an XSS surface.
 */
export interface WorkoutActivityInsightData {
  /** The cached, plain-text insight paragraph. Rendered as text children. */
  paragraph: string;
  /** ISO timestamp the paragraph was generated. */
  generatedAt: string;
}

export function WorkoutInsightCard({
  insight,
}: {
  insight: WorkoutActivityInsightData;
}) {
  const { t } = useTranslations();
  return (
    <Card data-slot="workout-detail-insight">
      <CardHeader>
        <TileHeader
          icon={Sparkles}
          title={t("insights.workouts.detail.insightTitle")}
          titleAs="h2"
        />
      </CardHeader>
      <CardContent>
        <p className="text-sm leading-relaxed">{insight.paragraph}</p>
      </CardContent>
    </Card>
  );
}
