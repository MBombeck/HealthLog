"use client";

/**
 * "What is this page filed against?": the document's one link row on the
 * vault's detail sheet. Its conditions, its visits, its doses and whatever
 * the server relates it to (lab results read from it, the medications it
 * belongs to) are one row of chips, each opening its record. Someone who may
 * manage the vault gets one "Link" button that picks the family and opens
 * its picker.
 *
 * Both links already existed as tables, but only one end could write them:
 * a visit's form picked its documents, a dose's form picked its pages, and
 * the document itself could show its visits read-only and its doses not at
 * all. A childhood record covering a dozen doses had to be attached dose by
 * dose, from twelve forms. Here the page lists what it is filed against and,
 * for someone who may manage the vault, links and unlinks it in one place.
 * Both ends write the SAME table through the link service, so the dose's
 * form and this sheet cannot disagree about what is filed where.
 *
 * Every name and date comes from the server: the visit kind as its enum
 * constant for the reader's bundle, the dose as its catalogue slug or the
 * person's own wording. The pick lists come from the visit and vaccination
 * list routes, with the records dated near the document on top under the
 * same seven-day window the upload suggestion uses.
 *
 * A module that is off leaves no block behind, and a grant that does not
 * reach the doses (`vaccinationLinks: null`) shows no dose block rather than
 * an empty one that would claim the page records none.
 */
import { useMemo, useState } from "react";
import { Activity, CalendarDays, Syringe } from "lucide-react";

import {
  EntityLinkPicker,
  serverPagingFrom,
} from "@/components/links/entity-link-picker";
import {
  RecordLinkAddButton,
  RecordLinksRow,
  type RecordLinkAddOption,
  relatedChips,
  type RecordLinkChipData,
} from "@/components/links/record-links";
import type { EntityLinkOption } from "@/components/links/entity-link-picker";
import { isNearAnchor } from "@/components/links/vault-document-options";
import { encounterPickerUrl } from "@/components/links/picker-requests";
import {
  PICKER_PAGE_SIZE,
  pickerPivot,
  useLinkPickerPages,
  type PickerPage,
  type PickerPageRequest,
} from "@/components/links/use-link-picker-pages";
import { encounterKindText } from "@/components/encounters/encounter-labels";
import { useVaccinations } from "@/components/vaccinations/use-vaccinations";
import { useAuth } from "@/hooks/use-auth";
import { apiGet } from "@/lib/api/api-fetch";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { useCalendarDate } from "@/hooks/use-calendar-date";
import { queryKeys } from "@/lib/query-keys";
import type { EncounterDTO, EncounterListDTO } from "@/lib/encounters/dto";
import type { EncounterKind } from "@/generated/prisma/client";
import type { InboundDocumentDetailDto } from "@/lib/validations/inbound-documents";
import type { IllnessEpisodeDTO } from "@/lib/illness/dto";
import type { RelatedLink } from "@/lib/links/related";
import { careVisitPath } from "@/lib/encounters/visit-links";
import { recordHref } from "@/lib/links/hrefs";

type Translate = ReturnType<typeof useTranslations>["t"];

/** Records near the document first, then the rest by year, newest first. */
export function recordOptions(
  records: ReadonlyArray<{
    id: string;
    label: string;
    meta?: string | null;
    occurredAt: string;
    href?: string | null;
  }>,
  anchor: string | null,
  labels: { suggested: string; date: (iso: string) => string },
): EntityLinkOption[] {
  const near: EntityLinkOption[] = [];
  const rest: EntityLinkOption[] = [];
  for (const record of records) {
    const option = {
      id: record.id,
      label: record.label,
      meta: record.meta ?? null,
      dateLabel: labels.date(record.occurredAt),
      href: record.href ?? null,
    };
    if (isNearAnchor(record.occurredAt, anchor)) {
      near.push({
        ...option,
        group: { key: "suggested", label: labels.suggested },
      });
    } else {
      const year = record.occurredAt.slice(0, 4);
      rest.push({ ...option, group: { key: year, label: year } });
    }
  }
  return [...near, ...rest];
}

/**
 * One picker page of visits. The route answers in two arms, each paged by the
 * same offset; another page exists while either arm came back full.
 */
export async function fetchEncounterPage(
  request: PickerPageRequest,
): Promise<PickerPage<EncounterDTO>> {
  const list = await apiGet<EncounterListDTO>(encounterPickerUrl(request));
  const full =
    list.upcoming.length >= PICKER_PAGE_SIZE ||
    list.past.length >= PICKER_PAGE_SIZE;
  return {
    items: [...list.upcoming, ...list.past],
    next: full
      ? String(Number(request.cursor ?? "0") + PICKER_PAGE_SIZE)
      : null,
  };
}

/** Where a visit opens: its sheet on the checkups page. */
function visitHref(encounterId: string): string {
  return careVisitPath(encounterId);
}

/** Where a dose opens: its sheet on the vaccinations page. */
function doseHref(vaccinationId: string): string {
  return `/vaccinations?dose=${encodeURIComponent(vaccinationId)}`;
}

/** A dose named the way the vaccination page names it. */
function doseName(
  t: Translate,
  catalogSlug: string | null,
  vaccineName: string | null,
): string {
  if (catalogSlug) return t(`vaccinations.catalog.${catalogSlug}`);
  return vaccineName ?? t("vaccinations.suggestion.unnamed");
}

/** The families a document files against itself; the rest come from `related[]`. */
const OWN_KINDS = ["conditionEpisode", "encounter", "vaccination"] as const;

type PickerKind = (typeof OWN_KINDS)[number];

/** What each picker offers: the records near the document first. */
function pickerOptions(
  t: Translate,
  format: ReturnType<typeof useFormatters>,
  calendarDate: (iso: string) => string,
  anchor: string | null,
  visits: readonly EncounterDTO[],
  doses: ReadonlyArray<{
    id: string;
    occurredAt: string;
    catalogEntry?: { slug: string } | null;
    vaccineName: string | null;
  }>,
  conditions: readonly IllnessEpisodeDTO[],
) {
  const suggested = t("links.picker.suggested");

  const visitOptions = recordOptions(
    [...visits]
      // Two arms per page arrive in two orders; the list reads newest first.
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .map((visit) => ({
        id: visit.id,
        label: encounterKindText(t, visit.kind as EncounterKind),
        meta: visit.practitioner?.name ?? null,
        occurredAt: visit.occurredAt,
        href: visitHref(visit.id),
      })),
    anchor,
    { suggested, date: format.date },
  );
  const doseOptions = recordOptions(
    doses.map((dose) => ({
      id: dose.id,
      label: doseName(t, dose.catalogEntry?.slug ?? null, dose.vaccineName),
      occurredAt: dose.occurredAt,
      href: doseHref(dose.id),
    })),
    anchor,
    { suggested, date: calendarDate }, // a dose date is a calendar date
  );
  const conditionOptions = conditions.map((episode) => ({
    id: episode.id,
    label: episode.label,
    dateLabel: episode.onsetAt ? format.date(episode.onsetAt) : null,
    href: recordHref("illness", episode.id),
  }));

  return { visitOptions, doseOptions, conditionOptions };
}

/** Everything the document is filed against, as one row of chips. */
function documentChips(
  t: Translate,
  format: ReturnType<typeof useFormatters>,
  calendarDate: (iso: string) => string,
  doc: InboundDocumentDetailDto,
  showDoses: boolean,
): RecordLinkChipData[] {
  return [
    ...doc.conditionLinks.map((link) => ({
      kind: "conditionEpisode" as const,
      id: link.episodeId,
      label: link.name,
      href: recordHref("illness", link.episodeId),
    })),
    ...doc.encounterLinks.map((link) => ({
      kind: "encounter" as const,
      id: link.encounterId,
      label: encounterKindText(t, link.kind as EncounterKind),
      dateLabel: link.occurredAt ? format.date(link.occurredAt) : null,
      href: visitHref(link.encounterId),
    })),
    ...(showDoses ? (doc.vaccinationLinks ?? []) : []).map((link) => ({
      kind: "vaccination" as const,
      id: link.vaccinationId,
      label: doseName(t, link.catalogSlug, link.vaccineName),
      dateLabel: link.occurredAt ? calendarDate(link.occurredAt) : null,
      href: doseHref(link.vaccinationId),
    })),
    // The lab results read from this page and the medications it belongs
    // to; the three families above are the document's own.
    ...relatedChips(
      t,
      format,
      calendarDate,
      (doc as { related?: RelatedLink[] }).related,
      OWN_KINDS,
    ),
  ];
}

/**
 * The caller mounts this keyed on the document and on its write-failure
 * count, so the local selection below starts over from the server's answer
 * whenever the sheet moves to another document or a write fails.
 */
export interface DocumentRecordLinksProps {
  doc: InboundDocumentDetailDto;
  canManage: boolean;
  /**
   * Whether `doc` was read from the server since the sheet opened. Every
   * change is a replace-set write seeded from `doc`'s links, so a seed from a
   * cached copy that predates a link made on the dose's or the visit's own
   * form would delete that link on the first tap. The pickers wait for a
   * fresh read instead.
   */
  seedFresh: boolean;
  /** That fresh read failed; the pickers show the retry row instead. */
  seedError?: boolean;
  onRetrySeed?: () => void;
  /** The person's conditions, for the condition picker. */
  episodes?: {
    data: IllnessEpisodeDTO[] | undefined;
    isPending: boolean;
    error: unknown;
    refetch: () => unknown;
  };
  onChange: (part: {
    episodeIds?: string[];
    encounterIds?: string[];
    vaccinationIds?: string[];
  }) => void;
}

export function DocumentRecordLinks({
  doc,
  canManage,
  seedFresh,
  seedError = false,
  onRetrySeed,
  episodes,
  onChange,
}: DocumentRecordLinksProps) {
  const { t } = useTranslations();
  const format = useFormatters();
  const calendarDate = useCalendarDate();
  const { user } = useAuth();
  const vaccinationsOn = user?.modules?.vaccinations !== false;
  const illnessOn = user?.modules?.illness !== false;
  const anchor = doc.documentDate ?? doc.reportDate;
  const [picking, setPicking] = useState<PickerKind | null>(null);

  // The visits around the document's date, paged older and newer from
  // there. The visit route has no text search (its free text is ciphertext
  // at rest), so the term filters what is loaded.
  const encounters = useLinkPickerPages<EncounterDTO>({
    enabled: canManage,
    pivot: pickerPivot(anchor),
    queryKey: queryKeys.encounterPicker,
    fetchPage: fetchEncounterPage,
    serverSearch: false,
  });
  const vaccinations = useVaccinations(
    null,
    canManage && vaccinationsOn && doc.vaccinationLinks !== null,
  );

  // The selection the person is editing, ahead of the server. Each change is
  // sent as the whole set (a replace-set PATCH), so a quick second tap never
  // computes from a list the first tap has not refreshed yet.
  const [conditionIds, setConditionIds] = useState<string[] | null>(null);
  const [visitIds, setVisitIds] = useState<string[] | null>(null);
  const [doseIds, setDoseIds] = useState<string[] | null>(null);

  const { visitOptions, doseOptions, conditionOptions } = pickerOptions(
    t,
    format,
    calendarDate,
    anchor,
    encounters.items,
    vaccinations.data?.vaccinations ?? [],
    episodes?.data ?? [],
  );

  const showDoses = vaccinationsOn && doc.vaccinationLinks !== null;

  // The visits the document is filed against, as its own read names them,
  // so their chips show whatever page of visits is loaded.
  const knownVisits = useMemo(
    () =>
      doc.encounterLinks.map((link) => ({
        id: link.encounterId,
        label: encounterKindText(t, link.kind as EncounterKind),
        dateLabel: link.occurredAt ? format.date(link.occurredAt) : null,
        href: visitHref(link.encounterId),
      })),
    [doc.encounterLinks, t, format],
  );
  const knownConditions = useMemo(
    () =>
      doc.conditionLinks.map((link) => ({
        id: link.episodeId,
        label: link.name,
        href: recordHref("illness", link.episodeId),
      })),
    [doc.conditionLinks],
  );

  const chips = documentChips(t, format, calendarDate, doc, showDoses);

  const addOptions: RecordLinkAddOption[] = [];
  if (canManage) {
    if (illnessOn && episodes) {
      addOptions.push({
        kind: "conditionEpisode",
        onSelect: () => setPicking("conditionEpisode"),
      });
    }
    addOptions.push({
      kind: "encounter",
      onSelect: () => setPicking("encounter"),
    });
    if (showDoses) {
      addOptions.push({
        kind: "vaccination",
        onSelect: () => setPicking("vaccination"),
      });
    }
  }

  const sheetProps = (kind: PickerKind) => ({
    sheetOnly: true,
    open: picking === kind,
    onOpenChange: (open: boolean) => setPicking(open ? kind : null),
    searchPlaceholder: t("links.picker.searchPlaceholder"),
    emptyLabel: t("links.related.nothingToOffer"),
    errorLabel: t("links.picker.loadError"),
  });

  return (
    <>
      <RecordLinksRow
        slot="document-links"
        chips={chips}
        add={
          addOptions.length > 0 ? (
            <RecordLinkAddButton
              options={addOptions}
              slot="document-links"
              // Every pick is a replace-set write seeded from `doc`; until
              // the sheet has read it fresh, a pick could drop a link made
              // elsewhere. A failed read opens through to its retry row.
              disabled={!seedFresh && !seedError}
            />
          ) : null
        }
      />

      {canManage && illnessOn && episodes ? (
        <EntityLinkPicker
          {...sheetProps("conditionEpisode")}
          icon={Activity}
          title={t("links.related.pick.conditionEpisode")}
          slot="document-condition-links"
          pending={episodes.isPending || !seedFresh}
          error={episodes.error || seedError}
          onRetry={() => {
            if (episodes.error) void episodes.refetch();
            if (seedError) onRetrySeed?.();
          }}
          selected={
            conditionIds ?? doc.conditionLinks.map((link) => link.episodeId)
          }
          onChange={(ids) => {
            setConditionIds(ids);
            onChange({ episodeIds: ids });
          }}
          options={conditionOptions}
          knownOptions={knownConditions}
        />
      ) : null}

      {canManage ? (
        <EntityLinkPicker
          {...sheetProps("encounter")}
          icon={CalendarDays}
          title={t("links.related.pick.encounter")}
          slot="document-visit-links"
          pending={encounters.pending || !seedFresh}
          error={encounters.error || seedError}
          onRetry={() => {
            if (encounters.error) encounters.retry();
            if (seedError) onRetrySeed?.();
          }}
          selected={visitIds ?? doc.encounterLinks.map((l) => l.encounterId)}
          onChange={(ids) => {
            setVisitIds(ids);
            onChange({ encounterIds: ids });
          }}
          options={visitOptions}
          server={serverPagingFrom(encounters)}
          knownOptions={knownVisits}
        />
      ) : null}

      {showDoses && canManage ? (
        <EntityLinkPicker
          {...sheetProps("vaccination")}
          icon={Syringe}
          title={t("links.related.pick.vaccination")}
          slot="document-vaccination-links"
          pending={vaccinations.isPending || !seedFresh}
          error={vaccinations.error || seedError}
          onRetry={() => {
            if (vaccinations.isError) void vaccinations.refetch();
            if (seedError) onRetrySeed?.();
          }}
          selected={
            doseIds ??
            (doc.vaccinationLinks ?? []).map((link) => link.vaccinationId)
          }
          onChange={(ids) => {
            setDoseIds(ids);
            onChange({ vaccinationIds: ids });
          }}
          options={doseOptions}
        />
      ) : null}
    </>
  );
}
