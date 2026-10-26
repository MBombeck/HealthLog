"use client";

import { useMemo } from "react";

import {
  bodySiteText,
  encounterKindText,
} from "@/components/encounters/encounter-labels";
import type { EncounterKind } from "@/generated/prisma/client";
import { useEncounters } from "@/hooks/use-encounters";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type {
  DocumentUsageDto,
  InboundDocumentDto,
} from "@/lib/validations/inbound-documents";

import type { ConditionChip } from "../document-filter-bar";
import {
  buildProcedureChoices,
  documentDateKey,
  type ProcedureFilterChoice,
} from "../vault-utils";

import type { VaultFilters } from "./use-vault-filters";

/**
 * How many visits the bulk bar offers. A menu is a picker, not a history: past
 * the first screenful a person scrolls rather than reads, and filing against a
 * visit older than this belongs on the visit's own sheet.
 */
const BULK_VISIT_OPTIONS = 12;

/**
 * The choices the filter bar and the bulk bar offer: conditions and
 * procedures with linked documents, the visits a selection can be filed
 * against, and the years present.
 */
export function useVaultFilterChoices({
  filters,
  usage,
  episodes,
  documents,
  timezone,
  inSharedRecord,
  sections,
}: {
  filters: VaultFilters["filters"];
  usage: DocumentUsageDto | undefined;
  episodes: Array<{ id: string; label: string }> | undefined;
  documents: InboundDocumentDto[];
  timezone: string;
  inSharedRecord: boolean;
  sections: readonly string[] | null;
}) {
  const { t } = useTranslations();
  const format = useFormatters();
  // Condition chips: every episode carrying at least one live document
  // link, served by the usage endpoint (NOT derived from the loaded corpus
  // — an old linked document pages deep must still surface its chip), plus
  // the actively filtered episode (a deep link must always show its own
  // chip, even when its last link was just removed).
  const conditionChips = useMemo<ConditionChip[]>(() => {
    const byId = new Map<string, string>();
    for (const link of usage?.linkedEpisodes ?? []) {
      byId.set(link.episodeId, link.name);
    }
    if (filters.episodeId && !byId.has(filters.episodeId)) {
      const episode = episodes?.find((e) => e.id === filters.episodeId);
      byId.set(filters.episodeId, episode?.label ?? filters.episodeId);
    }
    return [...byId.entries()]
      .map(([episodeId, name]) => ({ episodeId, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [usage?.linkedEpisodes, filters.episodeId, episodes]);

  // The visits the bulk bar can file a selection against: the account's own,
  // read through the same list the checkups page shows. Labelled here rather
  // than in the bar so the label uses the reader's locale for the kind and the
  // reader's timezone for the date — both presentation, both this side's job.
  const visits = useEncounters(
    !inSharedRecord || sections === null || sections.includes("profile"),
  );
  const bulkEncounterOptions = useMemo(
    () =>
      [...(visits.data?.upcoming ?? []), ...(visits.data?.past ?? [])]
        .slice(0, BULK_VISIT_OPTIONS)
        .map((visit) => ({
          id: visit.id,
          label: `${
            visit.practitioner?.name ??
            encounterKindText(t, visit.kind as EncounterKind)
          }, ${format.date(visit.occurredAt)}`,
        })),
    [visits.data, t, format],
  );

  // Procedure choices: every procedure carrying at least one live document
  // link, served by the usage endpoint for the same reason as the condition
  // chips, plus the actively filtered visit when it is a procedure (see
  // `buildProcedureChoices`).
  const procedureChips = useMemo<ProcedureFilterChoice[]>(() => {
    const activeVisit = filters.encounterId
      ? [...(visits.data?.upcoming ?? []), ...(visits.data?.past ?? [])].find(
          (v) => v.id === filters.encounterId && v.kind === "PROCEDURE",
        )
      : undefined;
    return buildProcedureChoices(
      usage?.linkedProcedures ?? [],
      activeVisit
        ? {
            encounterId: activeVisit.id,
            occurredAt: activeVisit.occurredAt,
            reason: activeVisit.reason,
            bodySite: activeVisit.bodySite,
            laterality: activeVisit.laterality,
            practitionerName: activeVisit.practitioner?.name ?? null,
          }
        : null,
      {
        kindName: encounterKindText(t, "PROCEDURE"),
        siteText: (site, laterality) => bodySiteText(t, site, laterality),
        formatDate: (iso) => format.date(iso),
      },
    );
  }, [usage?.linkedProcedures, filters.encounterId, visits.data, t, format]);

  // Year segmenter: years present in the loaded corpus (+ the active year).
  const years = useMemo(() => {
    const set = new Set<number>();
    for (const doc of documents) {
      set.add(Number(documentDateKey(doc, timezone).slice(0, 4)));
    }
    if (filters.year !== undefined) set.add(filters.year);
    return [...set].sort((a, b) => b - a);
  }, [documents, filters.year, timezone]);

  return { conditionChips, bulkEncounterOptions, procedureChips, years };
}
