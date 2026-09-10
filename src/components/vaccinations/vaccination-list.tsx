"use client";

/**
 * The immunization log, grouped the way an Impfpass answers its two questions:
 * "what have I had" and "where does each series stand".
 *
 * ── Grouping by component antigen ──────────────────────────────────────────
 *
 * A group is one antigen with at least one live dose. A combination record
 * renders a row in EVERY component group — one Tdap shows up three times, once
 * under tetanus, once under diphtheria, once under pertussis, each appearance
 * carrying that component's own resolved series values. This is render-only
 * duplication: one record, several appearances, and the numbers come straight
 * from the DTO's `series` array, never recomputed here.
 *
 * A free-text-only record, and a record whose slug the catalogue no longer
 * resolves, carries an empty `series` and groups under its verbatim
 * `vaccineName` instead — the degrade the DTO's `catalogEntry: null` signals,
 * now visible.
 *
 * ── Neutral, retrospective ─────────────────────────────────────────────────
 *
 * No due status anywhere on this page. A booster the user set shows on
 * `/checkups` like every other reminder; this surface reproduces the record
 * and does not adjudicate it. Cards are neutral — content in foreground, meta
 * in muted, no tint.
 */
import { Syringe } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { InfoPopover } from "@/components/ui/info-popover";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { SeriesPosition } from "@/lib/vaccinations/series";
import type { Vaccination } from "./use-vaccinations";
import { CatalogInfo, catalogInfoAvailable } from "./catalog-info";

type Translate = ReturnType<typeof useTranslations>["t"];

/** One dose as it appears inside one antigen group. */
interface GroupRow {
  record: Vaccination;
  /** This group's resolved position, or null for a free-text group. */
  position: SeriesPosition | null;
}

interface AntigenGroup {
  /** Dedup / React key. */
  key: string;
  /** The catalogue antigen slug, or null for a free-text group. */
  antigen: string | null;
  /** The verbatim heading for a free-text group. */
  freeName: string | null;
  rows: GroupRow[];
}

/**
 * The record's own identity, for the muted "· Tdap" marker that lets a reader
 * recognise a combined dose inside a single-antigen group. A catalogue slug
 * resolves through the dynamic name key; a free-text record shows its wording.
 */
function recordIdentity(t: Translate, record: Vaccination): string | null {
  if (record.catalogEntry)
    return t(`vaccinations.catalog.${record.catalogEntry.slug}`);
  return record.vaccineName;
}

/** The series sentence for one appearance, composed from resolved numbers. */
function seriesLabel(
  t: Translate,
  position: SeriesPosition | null,
): string | null {
  if (!position) return null;
  if (position.booster) return t("vaccinations.series.booster");
  if (position.total !== null) {
    return t("vaccinations.series.ofTotal", {
      position: position.position,
      total: position.total,
    });
  }
  return t("vaccinations.series.doseN", { position: position.position });
}

/**
 * Fold the flat, newest-first list into antigen groups.
 *
 * The server already sorts the list `occurredAt desc`, so pushing in order
 * keeps every group newest-first without a second sort. A record with at least
 * one `series` entry lands in each of its component groups; one with none folds
 * into a free-text group keyed by its verbatim name.
 */
function groupByAntigen(records: readonly Vaccination[]): AntigenGroup[] {
  const groups = new Map<string, AntigenGroup>();

  const ensure = (
    key: string,
    seed: Omit<AntigenGroup, "rows">,
  ): AntigenGroup => {
    let group = groups.get(key);
    if (!group) {
      group = { ...seed, rows: [] };
      groups.set(key, group);
    }
    return group;
  };

  for (const record of records) {
    if (record.series.length > 0) {
      for (const position of record.series) {
        ensure(`antigen:${position.antigen}`, {
          key: `antigen:${position.antigen}`,
          antigen: position.antigen,
          freeName: null,
        }).rows.push({ record, position });
      }
      continue;
    }
    // No resolvable antigen: a free-text row or a dead slug. Its verbatim name
    // is the heading; the slug is the last-resort key so a nameless dead-slug
    // row still lands somewhere rather than colliding with another.
    const name = record.vaccineName ?? record.antigenSlug ?? "—";
    const key = `free:${name}`;
    ensure(key, { key, antigen: null, freeName: name }).rows.push({
      record,
      position: null,
    });
  }

  // Antigen groups first (alphabetical by resolved-independent slug for a
  // stable order), then free-text groups after, also stable.
  return [...groups.values()].sort((a, b) => {
    if ((a.antigen === null) !== (b.antigen === null)) {
      return a.antigen === null ? 1 : -1;
    }
    return a.key.localeCompare(b.key);
  });
}

function DoseRow({
  row,
  onEdit,
}: {
  row: GroupRow;
  onEdit?: (record: Vaccination) => void;
}) {
  const { t } = useTranslations();
  const format = useFormatters();
  const { record, position } = row;
  const series = seriesLabel(t, position);
  const identity = recordIdentity(t, record);
  // Inside an antigen group, mark a dose whose own preparation is not this
  // antigen — a combined shot — so the reader sees it was a Tdap, not a
  // monovalent tetanus. In a free-text group the heading already is the name.
  const showIdentity =
    position !== null && record.catalogEntry?.slug !== position.antigen;

  return (
    <Card
      className="hover:bg-muted/40 gap-0 transition-colors"
      data-slot="vaccination-row"
      // A second, stable marker for the state rather than for the row: the
      // `role` is markup that could legitimately change, and a guard matching
      // on it would pass the day a real `<button>` replaced the card.
      data-slot-open={onEdit ? "vaccination-row-open" : undefined}
      data-vaccination-id={record.id}
      onClick={onEdit ? () => onEdit(record) : undefined}
      role={onEdit ? "button" : undefined}
      tabIndex={onEdit ? 0 : undefined}
      onKeyDown={
        onEdit
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onEdit(record);
              }
            }
          : undefined
      }
    >
      <CardContent className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-x-2 text-sm">
            {series ? (
              <span
                className="text-foreground font-medium"
                data-slot="vaccination-series"
              >
                {series}
              </span>
            ) : null}
            {showIdentity && identity ? (
              <span className="text-muted-foreground">· {identity}</span>
            ) : null}
          </div>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
            <span>{format.date(record.occurredAt)}</span>
            {record.lotNumber ? (
              <span data-slot="vaccination-lot">
                {t("vaccinations.row.lot", { lot: record.lotNumber })}
              </span>
            ) : null}
            {record.practitioner?.name ? (
              <span>{record.practitioner.name}</span>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function VaccinationList({
  records,
  onEdit,
}: {
  records: readonly Vaccination[];
  onEdit?: (record: Vaccination) => void;
}) {
  const { t } = useTranslations();
  const groups = groupByAntigen(records);

  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <section
          key={group.key}
          className="space-y-2"
          data-slot="vaccination-group"
          data-antigen={group.antigen ?? "free"}
        >
          <h2 className="text-muted-foreground flex items-center gap-2 text-xs font-medium tracking-wide uppercase">
            <Syringe className="size-3.5" aria-hidden />
            {group.antigen
              ? t(`vaccinations.catalog.${group.antigen}`)
              : group.freeName}
            <span className="normal-case">({group.rows.length})</span>
            {group.antigen && catalogInfoAvailable(group.antigen) ? (
              <InfoPopover
                label={t("vaccinations.info.affordanceLabel")}
                content={<CatalogInfo slug={group.antigen} />}
                iconClassName="h-3 w-3"
                triggerDataSlot="vaccination-info-trigger"
              />
            ) : null}
          </h2>
          <div className="space-y-2">
            {group.rows.map((row, index) => (
              <DoseRow
                key={`${row.record.id}:${index}`}
                row={row}
                onEdit={onEdit}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
