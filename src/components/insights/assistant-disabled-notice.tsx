"use client";

import { Sparkles } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/**
 * v1.4.31 — Small inline notice surfaced when an assistant surface
 * is gated off by the operator. Used by callers that already
 * resolved a `errorCode: "assistant.disabled.<surface>"` response
 * from the server or that detected the matching flag locally via
 * `useFeatureFlags()`.
 *
 * The copy intentionally stays generic — "currently unavailable on
 * this server" — so the surface doesn't leak operator-identity
 * info into a user-facing string. Marc-voice English; the locale
 * key carries the surface-specific phrasing.
 */
export type AssistantDisabledSurface =
  | "coach"
  | "briefing"
  | "insightStatus"
  | "correlations";

interface AssistantDisabledNoticeProps {
  surface: AssistantDisabledSurface;
  className?: string;
  variant?: "card" | "inline";
}

const SURFACE_LABEL_KEY: Record<AssistantDisabledSurface, string> = {
  coach: "insights.coach.disabledByOperator",
  briefing: "insights.briefingDisabledByOperator",
  insightStatus: "insights.statusDisabledByOperator",
  correlations: "insights.correlationsDisabledByOperator",
};

export function AssistantDisabledNotice({
  surface,
  className,
  variant = "card",
}: AssistantDisabledNoticeProps) {
  const { t } = useTranslations();
  const message = t(SURFACE_LABEL_KEY[surface]);

  if (variant === "inline") {
    return (
      <p
        data-slot="assistant-disabled-notice"
        className={cn("text-muted-foreground text-sm", className)}
      >
        {message}
      </p>
    );
  }

  return (
    <Card
      data-slot="assistant-disabled-notice"
      className={cn("opacity-70", className)}
    >
      <CardContent className="flex items-start gap-3 py-4">
        <Sparkles
          className="text-muted-foreground mt-0.5 size-4 shrink-0"
          aria-hidden="true"
        />
        <p className="text-muted-foreground text-sm">{message}</p>
      </CardContent>
    </Card>
  );
}
