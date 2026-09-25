"use client";

/**
 * The visit form's three optional link blocks: documents, lab results,
 * conditions. Each is the shared {@link EntityLinkPicker} — an inline summary
 * (removable chips + an add button) over a searchable, grouped sheet.
 *
 * **The gate blanks the block, it does not post-filter it.** A module the
 * account turned off leaves nothing behind here — no heading, no empty list,
 * no "0 selected". An empty picker for a switched-off module advertises a
 * feature that is not there. This is the same shape the dashboard snapshot
 * uses for a disabled module.
 *
 * The encounter itself carries NO module gate. A visit is core, like the
 * checkups page it lives on; what it may point AT follows the modules that own
 * those things, which is why the gate lives here and not on the route.
 *
 * Nothing in this block can block a save. Every list starts empty and stays
 * valid empty. The picker raises only the FETCH limit so grouping has enough
 * to group; the link cap stays authoritative on the server.
 */
import { useQuery } from "@tanstack/react-query";
import { FlaskConical, FolderOpen, Stethoscope } from "lucide-react";

import { apiGet } from "@/lib/api/api-fetch";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { ModuleKey } from "@/lib/modules/registry";
import type { IllnessEpisodeDTO } from "@/lib/illness/dto";
import {
  EntityLinkPicker,
  type EntityLinkOption,
} from "@/components/links/entity-link-picker";
import { useVaultDocumentOptions } from "@/components/links/vault-document-options";

/** Fetch cap for the picker — the grouped sheet needs enough rows to group. */
export const PICKER_FETCH_LIMIT = 200;

/**
 * The episode list route caps `limit` at 100 and answers anything above it
 * with a 422, which the picker used to read as "nothing here to link".
 */
export const EPISODE_FETCH_LIMIT = 100;

interface LabListPage {
  results: Array<{
    id: string;
    analyte: string;
    panel: string | null;
    takenAt: string;
  }>;
}

export function EncounterLinkPickers({
  modules,
  anchor,
  documentIds,
  labResultIds,
  episodeIds,
  onChange,
}: {
  modules: Partial<Record<ModuleKey, boolean>> | undefined;
  /** The visit's own date, for the document suggestions on top. */
  anchor: string | null;
  documentIds: string[];
  labResultIds: string[];
  episodeIds: string[];
  onChange: (part: {
    documentIds?: string[];
    labResultIds?: string[];
    episodeIds?: string[];
  }) => void;
}) {
  const { t } = useTranslations();
  const format = useFormatters();

  const documentsOn = modules?.inboundDocuments === true;
  const labsOn = modules?.labs === true;
  const illnessOn = modules?.illness === true;

  // The whole vault, suggestions near the visit's date on top — see
  // `useVaultDocumentOptions` for why this no longer asks for one oversized
  // page.
  const documents = useVaultDocumentOptions({
    enabled: documentsOn,
    anchor,
  });

  const labs = useQuery({
    queryKey: queryKeys.labResultsPicker(PICKER_FETCH_LIMIT),
    enabled: labsOn,
    queryFn: () =>
      apiGet<LabListPage>(
        `/api/labs?limit=${PICKER_FETCH_LIMIT}&offset=0&sortDir=desc`,
      ),
  });

  const episodes = useQuery({
    queryKey: queryKeys.illnessEpisodesPicker(EPISODE_FETCH_LIMIT),
    enabled: illnessOn,
    queryFn: () =>
      apiGet<IllnessEpisodeDTO[]>(
        `/api/illness/episodes?includeResolved=true&limit=${EPISODE_FETCH_LIMIT}`,
      ),
  });

  if (!documentsOn && !labsOn && !illnessOn) return null;

  // Labs group by sample date + panel: "Blutbild · 12.05.2026", the analyte
  // underneath. A visit links the whole panel from a day in one "select all".
  const labOptions: EntityLinkOption[] = (labs.data?.results ?? []).map(
    (result) => {
      const dayLabel = format.date(result.takenAt);
      const groupLabel = result.panel
        ? `${result.panel} · ${dayLabel}`
        : dayLabel;
      return {
        id: result.id,
        label: result.analyte,
        dateLabel: dayLabel,
        group: {
          key: `${result.takenAt.slice(0, 10)}|${result.panel ?? ""}`,
          label: groupLabel,
        },
      };
    },
  );

  // Episodes stay flat (a bounded list), newest onset first from the route.
  const episodeOptions: EntityLinkOption[] = (episodes.data ?? []).map(
    (episode) => ({
      id: episode.id,
      label: episode.label,
      dateLabel: episode.onsetAt ? format.date(episode.onsetAt) : null,
      href: `/illness/${encodeURIComponent(episode.id)}`,
    }),
  );

  return (
    <div className="space-y-4 border-t pt-4" data-slot="encounter-link-pickers">
      {documentsOn ? (
        <EntityLinkPicker
          icon={FolderOpen}
          title={t("encounters.form.linkDocuments")}
          slot="encounter-link-documents"
          pending={documents.pending}
          error={documents.error}
          errorLabel={t("links.picker.loadError")}
          onRetry={documents.retry}
          selected={documentIds}
          onChange={(ids) => onChange({ documentIds: ids })}
          options={documents.options}
          searchPlaceholder={t("links.picker.searchPlaceholder")}
          emptyLabel={t("encounters.form.linkNothingToOffer")}
        />
      ) : null}

      {labsOn ? (
        <EntityLinkPicker
          icon={FlaskConical}
          title={t("encounters.form.linkLabResults")}
          slot="encounter-link-labs"
          pending={labs.isPending}
          error={labs.isError}
          errorLabel={t("links.picker.loadError")}
          onRetry={() => void labs.refetch()}
          selected={labResultIds}
          onChange={(ids) => onChange({ labResultIds: ids })}
          options={labOptions}
          searchPlaceholder={t("links.picker.searchPlaceholder")}
          emptyLabel={t("encounters.form.linkNothingToOffer")}
        />
      ) : null}

      {illnessOn ? (
        <EntityLinkPicker
          icon={Stethoscope}
          title={t("encounters.form.linkConditions")}
          slot="encounter-link-conditions"
          pending={episodes.isPending}
          error={episodes.isError}
          errorLabel={t("links.picker.loadError")}
          onRetry={() => void episodes.refetch()}
          selected={episodeIds}
          onChange={(ids) => onChange({ episodeIds: ids })}
          options={episodeOptions}
          searchPlaceholder={t("links.picker.searchPlaceholder")}
          emptyLabel={t("encounters.form.linkNothingToOffer")}
        />
      ) : null}
    </div>
  );
}
