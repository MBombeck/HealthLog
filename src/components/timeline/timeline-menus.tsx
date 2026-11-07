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
 * Between the two it offers the person's own symptoms (#981) that have been
 * logged, hidden ones included and marked as such, on the same terms up to
 * `TIMELINE_SYMPTOM_SERIES_MAX`.
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
  TIMELINE_SYMPTOM_SERIES_MAX,
  timelineLabMarkerId,
  timelineSymptomDefinitionId,
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

/** A symptom the menu offers: its key, and whether it is hidden from entry. */
export interface SymptomOption {
  key: string;
  hidden: boolean;
}

export function ValueSeriesMenu({
  options,
  symptoms = [],
  labGroups = [],
  selected,
  label,
  color,
  onChange,
  iconOnly = false,
}: {
  options: readonly string[];
  /** The record's logged symptoms, in the record's own order. */
  symptoms?: readonly SymptomOption[];
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
  const symptomsFull =
    selected.filter((key) => timelineSymptomDefinitionId(key) !== null)
      .length >= TIMELINE_SYMPTOM_SERIES_MAX;
  const option = (key: string, hint?: string) => {
    const checked = selected.includes(key);
    return (
      <DropdownMenuCheckboxItem
        key={key}
        checked={checked}
        disabled={
          !checked &&
          ((labsFull && timelineLabMarkerId(key) !== null) ||
            (symptomsFull && timelineSymptomDefinitionId(key) !== null))
        }
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
        {hint ? (
          <span className="text-muted-foreground ml-auto text-xs">{hint}</span>
        ) : null}
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
        {options.map((key) => option(key))}
        {symptoms.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel data-slot="timeline-values-symptoms">
              {t("timeline.symptoms.menuTitle")}
            </DropdownMenuLabel>
            {symptomsFull && (
              <p
                data-slot="timeline-values-symptoms-full"
                className="text-muted-foreground px-2 pb-1 text-xs"
              >
                {t("timeline.symptoms.full", {
                  max: TIMELINE_SYMPTOM_SERIES_MAX,
                })}
              </p>
            )}
            <DropdownMenuGroup data-slot="timeline-values-symptom-group">
              {symptoms.map((s) =>
                option(
                  s.key,
                  s.hidden ? t("timeline.symptoms.hidden") : undefined,
                ),
              )}
            </DropdownMenuGroup>
          </>
        )}
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
                {group.keys.map((key) => option(key))}
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

/** Each symptom's name by its key, from what the server sent. */
export function symptomNames(
  timeline:
    Pick<TimelineResponse, "availableSymptoms" | "symptomSeries"> | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of [
    ...(timeline?.availableSymptoms ?? []),
    ...(timeline?.symptomSeries ?? []),
  ]) {
    if (s.label !== null) out.set(s.key, s.label);
  }
  return out;
}

/**
 * The values menu as the page holds it: every series the record has, the
 * chosen ones kept even when they have nothing yet, in `rank`'s order and
 * then the record's; then the record's logged symptoms in its own order;
 * then the record's lab markers by group. It counts and
 * toggles the lines it can name, so a stored marker the record no longer
 * has drops out with the next change.
 */
export function TimelineValuesMenu({
  timeline,
  values,
  allowed,
  rank,
  labsOn,
  symptomsOn,
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
  symptomsOn: boolean;
  label: (key: string) => string;
  color: (key: string) => string;
  onChange: (next: string[]) => void;
  iconOnly: boolean;
}) {
  const { locale } = useTranslations();
  const options = [
    ...new Set([
      ...(timeline?.availableSeries ?? []).filter(allowed),
      ...values.filter(
        (key) =>
          timelineLabMarkerId(key) === null &&
          timelineSymptomDefinitionId(key) === null,
      ),
    ]),
  ].sort((a, b) => rank.indexOf(a) - rank.indexOf(b));
  const markers = new Map(
    [...(timeline?.availableLabs ?? []), ...(timeline?.labSeries ?? [])].map(
      (m) => [m.key, m],
    ),
  );
  // A chosen symptom is offered even when the list no longer holds it (a
  // line sent for it names it), so it can be unticked.
  const symptomMap = new Map(
    [
      ...(timeline?.availableSymptoms ?? []),
      ...(timeline?.symptomSeries ?? []),
    ].map((s) => [s.key, { key: s.key, hidden: !s.isActive }]),
  );
  const symptoms = symptomsOn ? [...symptomMap.values()] : [];
  const labGroups = labsOn
    ? labOptionGroups([...markers.values()], resolveIntlLocale(locale))
    : [];
  return (
    <ValueSeriesMenu
      options={options}
      symptoms={symptoms}
      labGroups={labGroups}
      selected={values.filter((key) =>
        timelineLabMarkerId(key) !== null
          ? markers.has(key)
          : timelineSymptomDefinitionId(key) !== null
            ? symptomMap.has(key)
            : true,
      )}
      label={label}
      color={color}
      onChange={onChange}
      iconOnly={iconOnly}
    />
  );
}
