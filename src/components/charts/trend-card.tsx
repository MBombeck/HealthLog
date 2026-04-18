"use client";

import { ArrowDown, ArrowRight, ArrowUp, Minus } from "lucide-react";
import type { TrendSlope } from "@/lib/analytics/trends";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTranslations, useFormatters } from "@/lib/i18n/context";

interface TrendCardProps {
  label: string;
  latest: number | null;
  unit: string;
  avg7: number | null;
  avg30: number | null;
  avg7ColorClass?: string;
  avg30ColorClass?: string;
  avg7Hint?: React.ReactNode;
  avg30Hint?: React.ReactNode;
  slope30: TrendSlope | null;
  icon: React.ComponentType<{ className?: string }>;
}

export function TrendCard({
  label,
  latest,
  unit,
  avg7,
  avg30,
  avg7ColorClass,
  avg30ColorClass,
  avg7Hint,
  avg30Hint,
  slope30,
  icon: Icon,
}: TrendCardProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const TrendIcon =
    slope30?.direction === "up"
      ? ArrowUp
      : slope30?.direction === "down"
        ? ArrowDown
        : slope30
          ? ArrowRight
          : Minus;

  const trendColor =
    slope30?.direction === "up"
      ? "text-dracula-orange"
      : slope30?.direction === "down"
        ? "text-dracula-cyan"
        : "text-muted-foreground";

  const formatValue = (value: number) => fmt.number(value, 1);

  return (
    <div className="bg-card border-border rounded-xl border p-3">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-sm font-medium">
          {label}
        </span>
        <Icon className="text-muted-foreground h-4 w-4" />
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-2xl font-bold">
          {latest !== null ? formatValue(latest) : "—"}
        </span>
        <span className="text-muted-foreground text-sm">{unit}</span>
        {slope30 && <TrendIcon className={`h-4 w-4 ${trendColor}`} />}
      </div>
      <TooltipProvider>
        <div className="text-muted-foreground mt-1 flex gap-3 text-xs">
          {avg7 !== null && (
            <span>
              {t("charts.avg7dShort")}:{" "}
              {avg7Hint ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className={cn("font-medium", avg7ColorClass)}>
                      {formatValue(avg7)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="bg-muted border-border text-foreground">
                    <div className="space-y-1 text-xs">{avg7Hint}</div>
                  </TooltipContent>
                </Tooltip>
              ) : (
                <span className={cn("font-medium", avg7ColorClass)}>
                  {formatValue(avg7)}
                </span>
              )}
            </span>
          )}
          {avg30 !== null && (
            <span>
              {t("charts.avg30dShort")}:{" "}
              {avg30Hint ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className={cn("font-medium", avg30ColorClass)}>
                      {formatValue(avg30)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="bg-muted border-border text-foreground">
                    <div className="space-y-1 text-xs">{avg30Hint}</div>
                  </TooltipContent>
                </Tooltip>
              ) : (
                <span className={cn("font-medium", avg30ColorClass)}>
                  {formatValue(avg30)}
                </span>
              )}
            </span>
          )}
        </div>
      </TooltipProvider>
    </div>
  );
}
