"use client";

/**
 * The two menus above the chart (v1.42, #613): which value lines run under
 * the lanes, and which lanes show, with the way back into the readiness
 * inventory ("Data coverage").
 *
 * The value menu is one compact button, "Values (3)". The chosen lines are
 * not listed again beside it: each one is a named row under the lanes, and
 * the menu marks it with its colour. Below the measurements it offers the
 * lab markers the record has values for (#1299), under the groups the labs
 * list sorts them into; a lab line is chosen and stored like any other, up
 * to `TIMELINE_LAB_SERIES_MAX` at once: past it the unchosen markers are
 * held back with a line that says why, and a chosen one can always go.
 */
import { ChartLine, ChevronDown, Layers } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  TIMELINE_LAB_SERIES_MAX,
  timelineLabMarkerId,
  type TimelineLaneKey,
  type TimelineResponse,
} from "@/lib/day/contract";
import { resolveIntlLocale } from "@/lib/format-locale";
import { useTranslations } from "@/lib/i18n/context";

import { TIMELINE_LANE_LABEL_KEY } from "./label-keys";

/** Lab markers under one group of the labs list (null: no group). */
export interface LabOptionGroup {
  panel: string | null;
  keys: readonly string[];
}

export function ValueSeriesMenu({
  options,
  labGroups = [],
  selected,
  label,
  color,
  onChange,
  iconOnly = false,
}: {
  options: readonly string[];
  /** The record's lab markers, grouped as the labs list groups them. */
  labGroups?: readonly LabOptionGroup[];
  selected: readonly string[];
  label: (key: string) => string;
  /** A chosen line's colour, shown as a dot beside its name. */
  color: (key: string) => string;
  onChange: (next: string[]) => void;
  /** The phone toolbar's square button, named by its label. */
  iconOnly?: boolean;
}) {
  const { t } = useTranslations();
  const labsFull =
    selected.filter((key) => timelineLabMarkerId(key) !== null).length >=
    TIMELINE_LAB_SERIES_MAX;
  const option = (key: string) => {
    const checked = selected.includes(key);
    return (
      <DropdownMenuCheckboxItem
        key={key}
        checked={checked}
        disabled={labsFull && !checked && timelineLabMarkerId(key) !== null}
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
  };
  const trigger = t("timeline.values.trigger", { count: selected.length });
  // A group is named once there is more than one, or when it has a name.
  const namedGroups =
    labGroups.length > 1 || labGroups.some((g) => g.panel !== null);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size={iconOnly ? "icon" : "sm"}
          className={iconOnly ? "size-11" : "min-h-11 sm:min-h-9"}
          aria-label={iconOnly ? trigger : undefined}
          data-slot="timeline-values-trigger"
          data-count={selected.length}
        >
          <ChartLine className="size-4" aria-hidden="true" />
          {!iconOnly && trigger}
          {!iconOnly && <ChevronDown className="size-4" aria-hidden="true" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-64"
        data-slot="timeline-values-menu"
      >
        <DropdownMenuLabel>{t("timeline.values.menuTitle")}</DropdownMenuLabel>
        {options.map(option)}
        {labGroups.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel data-slot="timeline-values-labs">
              {t("timeline.labs.menuTitle")}
            </DropdownMenuLabel>
            {labsFull && (
              <p
                data-slot="timeline-values-labs-full"
                className="text-muted-foreground px-2 pb-1 text-xs"
              >
                {t("timeline.labs.full", { max: TIMELINE_LAB_SERIES_MAX })}
              </p>
            )}
            {labGroups.map((group) => (
              <DropdownMenuGroup
                key={group.panel ?? ""}
                data-slot="timeline-values-lab-group"
              >
                {namedGroups && (
                  <DropdownMenuLabel className="text-muted-foreground pt-2 pb-1 text-xs font-medium tracking-wide uppercase">
                    {group.panel ?? t("timeline.labs.otherPanel")}
                  </DropdownMenuLabel>
                )}
                {group.keys.map(option)}
              </DropdownMenuGroup>
            ))}
          </>
        )}
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

/**
 * The lab markers of the menu, grouped as the labs list groups them: by the
 * marker's group, named groups first, each in the reader's alphabetical
 * order, markers inside a group likewise.
 */
export function labOptionGroups(
  markers: ReadonlyArray<{ key: string; name: string; panel: string | null }>,
  intl: string,
): LabOptionGroup[] {
  const collator = new Intl.Collator(intl, { sensitivity: "base" });
  const groups = new Map<string | null, typeof markers>();
  const seen = new Set<string>();
  for (const marker of markers) {
    if (seen.has(marker.key)) continue;
    seen.add(marker.key);
    const panel = marker.panel?.trim() || null;
    groups.set(panel, [...(groups.get(panel) ?? []), marker]);
  }
  return [...groups]
    .sort(([a], [b]) =>
      a === null ? 1 : b === null ? -1 : collator.compare(a, b),
    )
    .map(([panel, list]) => ({
      panel,
      keys: [...list]
        .sort((a, b) => collator.compare(a.name, b.name))
        .map((m) => m.key),
    }));
}

/** Each lab marker's name by its key, from what the server sent. */
export function labMarkerNames(
  timeline: Pick<TimelineResponse, "availableLabs" | "labSeries"> | undefined,
): Map<string, string> {
  return new Map(
    [...(timeline?.availableLabs ?? []), ...(timeline?.labSeries ?? [])].map(
      (m) => [m.key, m.name],
    ),
  );
}

/**
 * The values menu as the page holds it: every series the record has, the
 * chosen ones kept even when they have nothing yet, in `rank`'s order and
 * then the record's; then the record's lab markers by group. It counts and
 * toggles the lines it can name, so a stored marker the record no longer
 * has drops out with the next change.
 */
export function TimelineValuesMenu({
  timeline,
  values,
  allowed,
  rank,
  labsOn,
  label,
  color,
  onChange,
  iconOnly,
}: {
  timeline: TimelineResponse | undefined;
  values: readonly string[];
  allowed: (key: string) => boolean;
  rank: readonly string[];
  labsOn: boolean;
  label: (key: string) => string;
  color: (key: string) => string;
  onChange: (next: string[]) => void;
  iconOnly: boolean;
}) {
  const { locale } = useTranslations();
  const options = [
    ...new Set([
      ...(timeline?.availableSeries ?? []).filter(allowed),
      ...values.filter((key) => timelineLabMarkerId(key) === null),
    ]),
  ].sort((a, b) => rank.indexOf(a) - rank.indexOf(b));
  const markers = new Map(
    [...(timeline?.availableLabs ?? []), ...(timeline?.labSeries ?? [])].map(
      (m) => [m.key, m],
    ),
  );
  const labGroups = labsOn
    ? labOptionGroups([...markers.values()], resolveIntlLocale(locale))
    : [];
  return (
    <ValueSeriesMenu
      options={options}
      labGroups={labGroups}
      selected={values.filter(
        (key) => timelineLabMarkerId(key) === null || markers.has(key),
      )}
      label={label}
      color={color}
      onChange={onChange}
      iconOnly={iconOnly}
    />
  );
}
