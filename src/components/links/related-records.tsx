"use client";

/**
 * "Verwandt": the records related to the one on screen, and the pickers that
 * file the v1.43 relation links.
 *
 * Every row comes from the detail read's `related[]`, resolved on the server:
 * the label, the date, the web path and how the relation runs (a stored link,
 * a visit both are filed against, or a medication's efficacy target). The
 * client renders it and never re-derives it, so the web, iOS and a push link
 * all open the same place.
 *
 * The pickers write through the record's own links route
 * (`POST/DELETE /api/<record>/{id}/links`) one change at a time and refresh
 * the detail read afterwards. Those routes are own-account only, so the
 * pickers render only in the caller's own record. A module that is off leaves
 * no picker behind, the same rule the visit form follows.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  CalendarDays,
  ChevronRight,
  FlaskConical,
  FolderOpen,
  Link2,
  Pill,
  Syringe,
  type LucideIcon,
} from "lucide-react";

import {
  EntityLinkPicker,
  serverPagingFrom,
  type EntityLinkOption,
} from "@/components/links/entity-link-picker";
import { useVaultDocumentOptions } from "@/components/links/vault-document-options";
import { useCalendarDate } from "@/hooks/use-calendar-date";
import {
  pickerPivot,
  useLinkPickerPages,
} from "@/components/links/use-link-picker-pages";
import { fetchEpisodePage } from "@/components/encounters/encounter-link-pickers";
import {
  ENCOUNTER_KINDS,
  encounterKindText,
} from "@/components/encounters/encounter-labels";
import {
  fetchEncounterPage,
  recordOptions,
} from "@/components/documents/document-record-links";
import { useVaccinations } from "@/components/vaccinations/use-vaccinations";
import { TileHeader } from "@/components/insights/tile-header";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { apiDelete, apiGet, apiPost } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { EncounterDTO } from "@/lib/encounters/dto";
import type { IllnessEpisodeDTO } from "@/lib/illness/dto";
import type { RelatedLink } from "@/lib/links/related";
import type { EncounterKind } from "@/generated/prisma/client";
import { translateOrNull } from "@/lib/i18n/translate-code";
import { visitPath } from "@/lib/encounters/visit-links";

type Translate = ReturnType<typeof useTranslations>["t"];
type RelatedKind = RelatedLink["kind"];

const KIND_ICONS: Record<RelatedKind, LucideIcon> = {
  labResult: FlaskConical,
  encounter: CalendarDays,
  document: FolderOpen,
  conditionEpisode: Activity,
  medication: Pill,
  vaccination: Syringe,
};

/** Literal calls, so the i18n coverage guard sees every key. */
function kindText(t: Translate, kind: RelatedKind): string {
  switch (kind) {
    case "labResult":
      return t("links.related.kind.labResult");
    case "encounter":
      return t("links.related.kind.encounter");
    case "document":
      return t("links.related.kind.document");
    case "conditionEpisode":
      return t("links.related.kind.conditionEpisode");
    case "medication":
      return t("links.related.kind.medication");
    case "vaccination":
      return t("links.related.kind.vaccination");
  }
}

function viaText(t: Translate, via: RelatedLink["via"]): string | null {
  if (via === "encounter") return t("links.related.via.encounter");
  if (via === "efficacyTarget") return t("links.related.via.efficacyTarget");
  return null;
}

/**
 * A visit without a reason or a practitioner is labelled by its kind, sent as
 * the enum constant so each reader names it from their own bundle.
 */
function rowLabel(t: Translate, row: RelatedLink): string {
  if (
    row.kind === "encounter" &&
    (ENCOUNTER_KINDS as string[]).includes(row.label)
  ) {
    return encounterKindText(t, row.label as EncounterKind);
  }
  // A dose without a written name arrives as its catalogue slug ("tetanus"),
  // named here from the reader's bundle the way the dose picker names it.
  if (row.kind === "vaccination" && /^[a-z0-9_-]+$/.test(row.label)) {
    const name = translateOrNull(t, `vaccinations.catalog.${row.label}`);
    if (name !== null) return name;
  }
  return row.label;
}

/** The related rows, grouped in the server's order. Nothing when empty. */
export function RelatedRecordsList({
  related,
  omitKinds = [],
}: {
  related: readonly RelatedLink[] | undefined;
  /** Kinds this surface already lists in a block of its own. */
  omitKinds?: readonly RelatedKind[];
}) {
  const { t } = useTranslations();
  const format = useFormatters();
  const calendarDate = useCalendarDate();
  const rows = (related ?? []).filter((row) => !omitKinds.includes(row.kind));
  if (rows.length === 0) return null;
  return (
    <ul className="divide-y" data-slot="related-records">
      {rows.map((row) => {
        const Icon = KIND_ICONS[row.kind];
        const via = viaText(t, row.via);
        const meta = [
          kindText(t, row.kind),
          row.date
            ? // A dose date is a calendar date at UTC midnight.
              row.kind === "vaccination"
              ? calendarDate(row.date)
              : format.date(row.date)
            : null,
          via,
        ]
          .filter(Boolean)
          .join(", ");
        return (
          <li key={`${row.kind}:${row.id}`}>
            <Link
              href={row.href}
              data-slot="related-record"
              className="hover:bg-muted/50 focus-visible:ring-ring/50 -mx-2 flex min-h-11 items-center gap-3 rounded-md px-2 py-2 focus-visible:ring-[3px] focus-visible:outline-none"
            >
              <Icon
                className="text-muted-foreground size-4 shrink-0"
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className="text-foreground block truncate text-sm">
                  {rowLabel(t, row)}
                </span>
                <span className="text-muted-foreground block truncate text-xs">
                  {meta}
                </span>
              </span>
              <ChevronRight
                className="text-muted-foreground size-4 shrink-0"
                aria-hidden
              />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The list in its own tile, for a page made of cards. Nothing when the
 * record relates to nothing the surface does not already show.
 */
export function RelatedRecordsCard({
  related,
  omitKinds = [],
}: {
  related: readonly RelatedLink[] | undefined;
  omitKinds?: readonly RelatedKind[];
}) {
  const { t } = useTranslations();
  if (!(related ?? []).some((row) => !omitKinds.includes(row.kind))) {
    return null;
  }
  return (
    <Card data-slot="related-records-card">
      <CardContent className="space-y-4">
        <TileHeader icon={Link2} title={t("links.related.title")} />
        <RelatedRecordsList related={related} omitKinds={omitKinds} />
      </CardContent>
    </Card>
  );
}

/** The list under a field-style label, for a sheet. */
export function RelatedRecordsBlock({
  related,
  omitKinds = [],
}: {
  related: readonly RelatedLink[] | undefined;
  omitKinds?: readonly RelatedKind[];
}) {
  const { t } = useTranslations();
  if (!(related ?? []).some((row) => !omitKinds.includes(row.kind))) {
    return null;
  }
  return (
    <div className="space-y-1.5" data-slot="related-records-block">
      <p className="text-sm leading-none font-medium">
        {t("links.related.title")}
      </p>
      <RelatedRecordsList related={related} omitKinds={omitKinds} />
    </div>
  );
}

/* ── pickers ──────────────────────────────────────────────────────────── */

type LinkableKind = Exclude<RelatedKind, "labResult">;

interface PickerProps {
  selected: string[];
  onChange: (ids: string[]) => void;
  anchor: string | null;
  known: EntityLinkOption[];
}

function ConditionPicker({ selected, onChange, anchor, known }: PickerProps) {
  const { t } = useTranslations();
  const format = useFormatters();
  const pages = useLinkPickerPages<IllnessEpisodeDTO>({
    enabled: true,
    pivot: pickerPivot(anchor),
    queryKey: queryKeys.illnessEpisodesPicker,
    fetchPage: fetchEpisodePage,
  });
  const options: EntityLinkOption[] = pages.items.map((episode) => ({
    id: episode.id,
    label: episode.label,
    dateLabel: episode.onsetAt ? format.date(episode.onsetAt) : null,
    href: `/illness/${encodeURIComponent(episode.id)}`,
  }));
  return (
    <EntityLinkPicker
      icon={Activity}
      title={t("links.related.pick.conditionEpisode")}
      slot="related-link-conditionEpisode"
      pending={pages.pending}
      error={pages.error}
      errorLabel={t("links.picker.loadError")}
      onRetry={pages.retry}
      selected={selected}
      onChange={onChange}
      options={options}
      server={serverPagingFrom(pages)}
      knownOptions={known}
      searchPlaceholder={t("links.picker.searchPlaceholder")}
      emptyLabel={t("links.related.nothingToOffer")}
    />
  );
}

function DocumentPicker({ selected, onChange, anchor, known }: PickerProps) {
  const { t } = useTranslations();
  const documents = useVaultDocumentOptions({ enabled: true, anchor });
  return (
    <EntityLinkPicker
      icon={FolderOpen}
      title={t("links.related.pick.document")}
      slot="related-link-document"
      pending={documents.pending}
      error={documents.error}
      errorLabel={t("links.picker.loadError")}
      onRetry={documents.retry}
      selected={selected}
      onChange={onChange}
      options={documents.options}
      server={documents.server}
      knownOptions={known}
      searchPlaceholder={t("links.picker.searchPlaceholder")}
      emptyLabel={t("links.related.nothingToOffer")}
    />
  );
}

function VisitPicker({ selected, onChange, anchor, known }: PickerProps) {
  const { t } = useTranslations();
  const format = useFormatters();
  const pages = useLinkPickerPages<EncounterDTO>({
    enabled: true,
    pivot: pickerPivot(anchor),
    queryKey: queryKeys.encounterPicker,
    fetchPage: fetchEncounterPage,
    serverSearch: false,
  });
  const options = recordOptions(
    [...pages.items]
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .map((visit) => ({
        id: visit.id,
        label: encounterKindText(t, visit.kind as EncounterKind),
        meta: visit.practitioner?.name ?? null,
        occurredAt: visit.occurredAt,
        href: visitPath(visit.id),
      })),
    anchor,
    {
      suggested: t("links.picker.suggested"),
      date: (iso: string) => format.date(iso),
    },
  );
  return (
    <EntityLinkPicker
      icon={CalendarDays}
      title={t("links.related.pick.encounter")}
      slot="related-link-encounter"
      pending={pages.pending}
      error={pages.error}
      errorLabel={t("links.picker.loadError")}
      onRetry={pages.retry}
      selected={selected}
      onChange={onChange}
      options={options}
      server={serverPagingFrom(pages)}
      knownOptions={known}
      searchPlaceholder={t("links.picker.searchPlaceholder")}
      emptyLabel={t("links.related.nothingToOffer")}
    />
  );
}

interface MedicationListRow {
  id: string;
  name: string;
  dose: string;
  active: boolean;
}

function MedicationPicker({ selected, onChange, known }: PickerProps) {
  const { t } = useTranslations();
  const list = useQuery({
    queryKey: queryKeys.medications(),
    queryFn: () => apiGet<MedicationListRow[]>("/api/medications"),
  });
  const options: EntityLinkOption[] = (
    Array.isArray(list.data) ? list.data : []
  ).map((med) => ({
    id: med.id,
    label: med.dose ? `${med.name} ${med.dose}` : med.name,
    href: `/medications/${encodeURIComponent(med.id)}`,
  }));
  return (
    <EntityLinkPicker
      icon={Pill}
      title={t("links.related.pick.medication")}
      slot="related-link-medication"
      pending={list.isPending}
      error={list.error}
      errorLabel={t("links.picker.loadError")}
      onRetry={() => void list.refetch()}
      selected={selected}
      onChange={onChange}
      options={options}
      knownOptions={known}
      searchPlaceholder={t("links.picker.searchPlaceholder")}
      emptyLabel={t("links.related.nothingToOffer")}
    />
  );
}

function DosePicker({ selected, onChange, anchor, known }: PickerProps) {
  const { t } = useTranslations();
  const calendarDate = useCalendarDate();
  const doses = useVaccinations(null, true);
  const options = recordOptions(
    (doses.data?.vaccinations ?? []).map((dose) => ({
      id: dose.id,
      label: dose.catalogEntry?.slug
        ? t(`vaccinations.catalog.${dose.catalogEntry.slug}`)
        : (dose.vaccineName ?? t("vaccinations.suggestion.unnamed")),
      occurredAt: dose.occurredAt,
      href: `/vaccinations?dose=${encodeURIComponent(dose.id)}`,
    })),
    anchor,
    { suggested: t("links.picker.suggested"), date: calendarDate },
  );
  return (
    <EntityLinkPicker
      icon={Syringe}
      title={t("links.related.pick.vaccination")}
      slot="related-link-vaccination"
      pending={doses.isPending}
      error={doses.error}
      errorLabel={t("links.picker.loadError")}
      onRetry={() => void doses.refetch()}
      selected={selected}
      onChange={onChange}
      options={options}
      knownOptions={known}
      searchPlaceholder={t("links.picker.searchPlaceholder")}
      emptyLabel={t("links.related.nothingToOffer")}
    />
  );
}

const PICKERS: Record<LinkableKind, (props: PickerProps) => React.ReactNode> = {
  conditionEpisode: ConditionPicker,
  document: DocumentPicker,
  encounter: VisitPicker,
  medication: MedicationPicker,
  vaccination: DosePicker,
};

/** The module each pickable kind belongs to; the visit is core. */
const KIND_MODULE: Record<LinkableKind, string | null> = {
  conditionEpisode: "illness",
  document: "inboundDocuments",
  encounter: null,
  medication: "medications",
  vaccination: "vaccinations",
};

/**
 * One picker per kind the record may file, each writing through `linksPath`.
 *
 * The caller mounts it keyed on the record so the local selection starts from
 * the server's answer whenever the record changes; a failed write puts the
 * selection back and says so.
 */
export function RelationLinkPickers({
  linksPath,
  kinds,
  related,
  anchor,
  onSaved,
}: {
  /** `/api/medications/{id}/links` and the like. */
  linksPath: string;
  kinds: readonly LinkableKind[];
  related: readonly RelatedLink[] | undefined;
  /** The record's own date, where the pickers open. */
  anchor: string | null;
  /** Refresh the detail read after a write. */
  onSaved: () => void;
}) {
  const { t } = useTranslations();
  const format = useFormatters();
  const { user } = useAuth();
  const { inSharedRecord } = useRecordCapabilities();

  const direct = useMemo(() => {
    const out = new Map<LinkableKind, RelatedLink[]>();
    for (const row of related ?? []) {
      if (row.via !== "direct" || row.kind === "labResult") continue;
      out.set(row.kind, [...(out.get(row.kind) ?? []), row]);
    }
    return out;
  }, [related]);

  const [selection, setSelection] = useState<
    Partial<Record<LinkableKind, string[]>>
  >({});

  if (inSharedRecord) return null;

  const visible = kinds.filter((kind) => {
    const key = KIND_MODULE[kind];
    return (
      key === null ||
      (user?.modules as Record<string, boolean> | undefined)?.[key] !== false
    );
  });
  if (visible.length === 0) return null;

  const write = async (kind: LinkableKind, next: string[]) => {
    const before =
      selection[kind] ?? (direct.get(kind) ?? []).map((row) => row.id);
    setSelection((current) => ({ ...current, [kind]: next }));
    const added = next.filter((id) => !before.includes(id));
    const removed = before.filter((id) => !next.includes(id));
    try {
      if (added.length > 0) {
        await apiPost(linksPath, { targetKind: kind, targetIds: added });
      }
      if (removed.length > 0) {
        await apiDelete(linksPath, { targetKind: kind, targetIds: removed });
      }
      onSaved();
    } catch (cause) {
      setSelection((current) => ({ ...current, [kind]: before }));
      showErrorToast(t("links.related.saveError"), { cause });
    }
  };

  return (
    <div className="space-y-4" data-slot="relation-link-pickers">
      {visible.map((kind) => {
        const Picker = PICKERS[kind];
        const known: EntityLinkOption[] = (direct.get(kind) ?? []).map(
          (row) => ({
            id: row.id,
            label: rowLabel(t, row),
            dateLabel: row.date ? format.date(row.date) : null,
            href: row.href,
          }),
        );
        return (
          <Picker
            key={kind}
            selected={
              selection[kind] ?? (direct.get(kind) ?? []).map((row) => row.id)
            }
            onChange={(ids) => void write(kind, ids)}
            anchor={anchor}
            known={known}
          />
        );
      })}
    </div>
  );
}
