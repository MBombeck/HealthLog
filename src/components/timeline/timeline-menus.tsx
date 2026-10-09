"use client";

/**
 * The two menus above the chart (v1.42, #613): which value lines run under
 * the lanes (at most six, the server's cap), and which lanes show, with the way back into
 * the readiness inventory ("Data coverage").
 */
import { ChartLine, ChevronDown, Layers } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TIMELINE_MAX_SERIES, type TimelineLaneKey } from "@/lib/day/contract";
import { useTranslations } from "@/lib/i18n/context";

/** The most value lines the chart runs under its lanes. */
export const MAX_VALUE_SERIES = TIMELINE_MAX_SERIES;

export function ValueSeriesMenu({
  options,
  selected,
  label,
  onChange,
}: {
  options: readonly string[];
  selected: readonly string[];
  label: (key: string) => string;
  onChange: (next: string[]) => void;
}) {
  const { t } = useTranslations();
  const summary =
    selected.length > 0
      ? selected.map(label).join(", ")
      : t("timeline.values.none");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="min-h-11 max-w-full sm:min-h-9"
          data-slot="timeline-values-trigger"
        >
          <ChartLine className="size-4" aria-hidden="true" />
          <span className="truncate">{summary}</span>
          <ChevronDown className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>{t("timeline.values.menuLabel")}</DropdownMenuLabel>
        {options.map((key) => {
          const checked = selected.includes(key);
          const full = !checked && selected.length >= MAX_VALUE_SERIES;
          return (
            <DropdownMenuCheckboxItem
              key={key}
              checked={checked}
              disabled={full}
              data-slot="timeline-values-option"
              data-key={key}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(next) =>
                onChange(
                  next ? [...selected, key] : selected.filter((k) => k !== key),
                )
              }
            >
              {label(key)}
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function LayersMenu({
  lanes,
  hidden,
  onToggle,
  onOpenReadiness,
  iconOnly = false,
}: {
  lanes: readonly TimelineLaneKey[];
  hidden: ReadonlySet<TimelineLaneKey>;
  onToggle: (lane: TimelineLaneKey, visible: boolean) => void;
  onOpenReadiness: () => void;
  iconOnly?: boolean;
}) {
  const { t } = useTranslations();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size={iconOnly ? "icon" : "sm"}
          className={iconOnly ? "size-11" : "min-h-11 sm:min-h-9"}
          aria-label={iconOnly ? t("timeline.layers") : undefined}
          data-slot="timeline-layers-trigger"
        >
          <Layers className="size-4" aria-hidden="true" />
          {!iconOnly && t("timeline.layers")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>{t("timeline.layersLanes")}</DropdownMenuLabel>
        {lanes.map((lane) => (
          <DropdownMenuCheckboxItem
            key={lane}
            checked={!hidden.has(lane)}
            data-slot="timeline-layer-option"
            data-lane={lane}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(next) => onToggle(lane, next === true)}
          >
            {t(`timeline.lanes.${lane}`)}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-slot="timeline-open-readiness"
          onSelect={onOpenReadiness}
        >
          {t("timeline.readiness.menuEntry")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
