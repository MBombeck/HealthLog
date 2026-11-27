"use client";

/**
 * The records related to the one on screen, as the shared link row
 * (`RecordLinksRow`), and the pickers that file the v1.43 relation links.
 *
 * Every chip comes from the detail read's `related[]`, resolved on the
 * server: the label, the date, the web path and how the relation runs (a
 * stored link, a visit both are filed against, or a medication's efficacy
 * target). The client renders it and never re-derives it, so the web, iOS
 * and a push link all open the same place.
 *
 * With `edit`, the row carries the one "Link" button: it picks a family and
 * opens that family's picker, which writes through the record's own links
 * route (`POST/DELETE /api/<record>/{id}/links`) one change at a time and
 * refreshes the detail read afterwards. Those routes are own-account only,
 * so the button renders only in the caller's own record. A module that is
 * off leaves no entry behind, the same rule the visit form follows.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  CalendarDays,
  FolderOpen,
  Pill,
  Syringe,
} from "lucide-react";

import {
  EntityLinkPicker,
  serverPagingFrom,
  type EntityLinkOption,
} from "@/components/links/entity-link-picker";
import {
  RecordLinkAddButton,
  RecordLinksRow,
  relatedChips,
  relatedRowLabel,
  type RecordLinkChipData,
} from "@/components/links/record-links";
import { useVaultDocumentOptions } from "@/components/links/vault-document-options";
import { useCalendarDate } from "@/hooks/use-calendar-date";
import {
  pickerPivot,
  useLinkPickerPages,
} from "@/components/links/use-link-picker-pages";
import { fetchEpisodePage } from "@/components/encounters/encounter-link-pickers";
import { encounterKindText } from "@/components/encounters/encounter-labels";
import {
  fetchEncounterPage,
  recordOptions,
} from "@/components/documents/document-record-links";
import { useVaccinations } from "@/components/vaccinations/use-vaccinations";
import { useAuth } from "@/hooks/use-auth";
import {
  useRecordCapabilities,
  holdsOwnerRights,
} from "@/hooks/use-record-capabilities";
import { apiDelete, apiGet, apiPost } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { EncounterDTO } from "@/lib/encounters/dto";
import type { IllnessEpisodeDTO } from "@/lib/illness/dto";
import type { RelatedLink } from "@/lib/links/related";
import type { EncounterKind } from "@/generated/prisma/client";
import { careVisitPath } from "@/lib/encounters/visit-links";

type RelatedKind = RelatedLink["kind"];

/* ── pickers ──────────────────────────────────────────────────────────── */

type LinkableKind = Exclude<RelatedKind, "labResult">;

interface PickerProps {
  selected: string[];
  onChange: (ids: string[]) => void;
  anchor: string | null;
  known: EntityLinkOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function ConditionPicker({
  selected,
  onChange,
  anchor,
  known,
  open,
  onOpenChange,
}: PickerProps) {
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
      sheetOnly
      open={open}
      onOpenChange={onOpenChange}
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

function DocumentPicker({
  selected,
  onChange,
  anchor,
  known,
  open,
  onOpenChange,
}: PickerProps) {
  const { t } = useTranslations();
  const documents = useVaultDocumentOptions({ enabled: true, anchor });
  return (
    <EntityLinkPicker
      sheetOnly
      open={open}
      onOpenChange={onOpenChange}
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

function VisitPicker({
  selected,
  onChange,
  anchor,
  known,
  open,
  onOpenChange,
}: PickerProps) {
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
        href: careVisitPath(visit.id),
      })),
    anchor,
    {
      suggested: t("links.picker.suggested"),
      date: (iso: string) => format.date(iso),
    },
  );
  return (
    <EntityLinkPicker
      sheetOnly
      open={open}
      onOpenChange={onOpenChange}
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

function MedicationPicker({
  selected,
  onChange,

  known,
  open,
  onOpenChange,
}: PickerProps) {
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
      sheetOnly
      open={open}
      onOpenChange={onOpenChange}
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

function DosePicker({
  selected,
  onChange,
  anchor,
  known,
  open,
  onOpenChange,
}: PickerProps) {
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
      sheetOnly
      open={open}
      onOpenChange={onOpenChange}
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

/** What a record may file from its own sheet, and where it writes. */
export interface RelationEdit {
  /** `/api/medications/{id}/links` and the like. */
  linksPath: string;
  kinds: readonly LinkableKind[];
  /** The record's own date, where the pickers open. */
  anchor: string | null;
  /** Refresh the detail read after a write. */
  onSaved: () => void;
}

interface RelatedProps {
  related: readonly RelatedLink[] | undefined;
  /** Kinds this surface already lists in a block of its own. */
  omitKinds?: readonly RelatedKind[];
  /**
   * The link button and its pickers. The caller mounts the component keyed
   * on the record, so the local selection starts from the server's answer
   * whenever the record changes; a failed write puts the selection back and
   * says so.
   */
  edit?: RelationEdit;
}

/** The chips, the add button and the open picker for one record. */
function useRelatedLinks({ related, omitKinds = [], edit }: RelatedProps) {
  const { t } = useTranslations();
  const format = useFormatters();
  const calendarDate = useCalendarDate();
  const { user } = useAuth();
  const ownerRights = holdsOwnerRights(useRecordCapabilities());

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
  const [picking, setPicking] = useState<LinkableKind | null>(null);
  // A picker stays mounted once opened, so its sheet can animate closed;
  // one that was never opened fetches nothing.
  const [opened, setOpened] = useState<ReadonlySet<LinkableKind>>(new Set());

  const chips: RecordLinkChipData[] = relatedChips(
    t,
    format,
    calendarDate,
    related,
    omitKinds,
  );

  const kinds =
    edit && ownerRights
      ? edit.kinds.filter((kind) => {
          const key = KIND_MODULE[kind];
          return (
            key === null ||
            (user?.modules as Record<string, boolean> | undefined)?.[key] !==
              false
          );
        })
      : [];

  const write = async (kind: LinkableKind, next: string[]) => {
    if (!edit) return;
    const before =
      selection[kind] ?? (direct.get(kind) ?? []).map((row) => row.id);
    setSelection((current) => ({ ...current, [kind]: next }));
    const added = next.filter((id) => !before.includes(id));
    const removed = before.filter((id) => !next.includes(id));
    try {
      if (added.length > 0) {
        await apiPost(edit.linksPath, { targetKind: kind, targetIds: added });
      }
      if (removed.length > 0) {
        await apiDelete(edit.linksPath, {
          targetKind: kind,
          targetIds: removed,
        });
      }
      edit.onSaved();
    } catch (cause) {
      setSelection((current) => ({ ...current, [kind]: before }));
      showErrorToast(t("links.related.saveError"), { cause });
    }
  };

  const add =
    kinds.length > 0 ? (
      <RecordLinkAddButton
        slot="related-links"
        options={kinds.map((kind) => ({
          kind,
          onSelect: () => {
            setOpened((current) => new Set(current).add(kind));
            setPicking(kind);
          },
        }))}
      />
    ) : null;

  const sheets =
    kinds.length > 0 ? (
      <>
        {kinds
          .filter((kind) => opened.has(kind))
          .map((kind) => {
            const Picker = PICKERS[kind];
            const known: EntityLinkOption[] = (direct.get(kind) ?? []).map(
              (row) => ({
                id: row.id,
                label: relatedRowLabel(t, row),
                dateLabel: row.date ? format.date(row.date) : null,
                href: row.href,
              }),
            );
            return (
              <Picker
                key={kind}
                selected={
                  selection[kind] ??
                  (direct.get(kind) ?? []).map((row) => row.id)
                }
                onChange={(ids) => void write(kind, ids)}
                anchor={edit?.anchor ?? null}
                known={known}
                open={picking === kind}
                onOpenChange={(open) => setPicking(open ? kind : null)}
              />
            );
          })}
      </>
    ) : null;

  return { chips, add, sheets };
}

/** The row under a field-style label, for a sheet. Nothing when empty. */
export function RelatedRecordsBlock(props: RelatedProps) {
  const { chips, add, sheets } = useRelatedLinks(props);
  return (
    <>
      <RecordLinksRow slot="related-records" chips={chips} add={add} />
      {sheets}
    </>
  );
}

/**
 * The row without its label, for a section whose own heading already says
 * what it is. Nothing when empty.
 */
export function RelatedRecordsList(props: RelatedProps) {
  const { chips, add, sheets } = useRelatedLinks(props);
  return (
    <>
      <RecordLinksRow
        slot="related-records"
        chips={chips}
        add={add}
        labelled={false}
      />
      {sheets}
    </>
  );
}
