"use client";

/**
 * The two menus above the chart (v1.42, #613): which value lines run under
 * the lanes, and which lanes show, with the way back into the readiness
 * inventory ("Data coverage").
 *
 * The value menu is one compact button, "Values (3)". The chosen lines are
 * not listed again beside it: each one is a named row under the lanes, and
 * the menu marks it with its colour.
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
import type { TimelineLaneKey } from "@/lib/day/contract";
import { useTranslations } from "@/lib/i18n/context";

import { TIMELINE_LANE_LABEL_KEY } from "./label-keys";

export function ValueSeriesMenu({
  options,
  selected,
  label,
  color,
  onChange,
}: {
  options: readonly string[];
  selected: readonly string[];
  label: (key: string) => string;
  /** A chosen line's colour, shown as a dot beside its name. */
  color: (key: string) => string;
  onChange: (next: string[]) => void;
}) {
  const { t } = useTranslations();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          data-slot="timeline-values-trigger"
          data-count={selected.length}
        >
          <ChartLine className="size-4" aria-hidden="true" />
          {t("timeline.values.trigger", { count: selected.length })}
          <ChevronDown className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-64"
        data-slot="timeline-values-menu"
      >
        <DropdownMenuLabel>{t("timeline.values.menuTitle")}</DropdownMenuLabel>
        {options.map((key) => {
          const checked = selected.includes(key);
          return (
            <DropdownMenuCheckboxItem
              key={key}
              checked={checked}
              data-slot="timeline-values-option"
              data-key={key}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(next) =>
                onChange(
                  next ? [...selected, key] : selected.filter((k) => k !== key),
                )
              }
            >
              {/* The dot is the line's colour on the chart; an unchosen
                  value has no line yet, so its place stays empty. */}
              <span
                data-slot="timeline-values-dot"
                className="size-2 shrink-0 rounded-full"
                style={checked ? { background: color(key) } : undefined}
                aria-hidden="true"
              />
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
            {t(TIMELINE_LANE_LABEL_KEY[lane])}
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
