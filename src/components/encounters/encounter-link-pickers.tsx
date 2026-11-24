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
 * valid empty, and the link cap stays authoritative on the server.
 *
 * **Every family is reachable however long the history.** The lab and
 * condition pickers used to load the newest 200 results and the newest 100
 * conditions and offer only those, so on a long record a visit from a few
 * years back could not reach its own lab panel. Each picker now opens on the
 * records around the visit's date and pages older and newer from there, and
 * its search asks the list route (`useLinkPickerPages`). What the visit
 * already links always shows, from the labels its own read carries.
 */
import { useMemo } from "react";
import { FlaskConical, FolderOpen, Stethoscope } from "lucide-react";

import { apiGet } from "@/lib/api/api-fetch";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { ModuleKey } from "@/lib/modules/registry";
import type { IllnessEpisodeDTO } from "@/lib/illness/dto";
import type { EncounterLinksDTO } from "@/lib/encounters/dto";
import {
  EntityLinkPicker,
  serverPagingFrom,
  type EntityLinkOption,
} from "@/components/links/entity-link-picker";
import {
  linkedDocumentOption,
  useVaultDocumentOptions,
} from "@/components/links/vault-document-options";
import {
  episodePickerUrl,
  labPickerUrl,
} from "@/components/links/picker-requests";
import {
  nextOffset,
  pickerPivot,
  useLinkPickerPages,
  type PickerPage,
  type PickerPageRequest,
} from "@/components/links/use-link-picker-pages";
import { ImportFromSourceButton } from "@/components/documents/sources/import-from-source-button";
import { mergeIds } from "@/components/documents/sources/merge-ids";

interface LabPickerResult {
  id: string;
  analyte: string;
  panel: string | null;
  takenAt: string;
}

interface LabListPage {
  results: LabPickerResult[];
}

/** One picker page of lab results. */
export async function fetchLabPage(
  request: PickerPageRequest,
): Promise<PickerPage<LabPickerResult>> {
  const page = await apiGet<LabListPage>(labPickerUrl(request));
  return {
    items: page.results,
    next: nextOffset(request.cursor, page.results.length),
  };
}

/** One picker page of condition episodes. */
export async function fetchEpisodePage(
  request: PickerPageRequest,
): Promise<PickerPage<IllnessEpisodeDTO>> {
  const rows = await apiGet<IllnessEpisodeDTO[]>(episodePickerUrl(request));
  return { items: rows, next: nextOffset(request.cursor, rows.length) };
}

/** A visit's existing link as a chip option, or null when it is withheld. */
function linkedOption(
  link: { id: string; label: string | null; date: string | null },
  date: (iso: string) => string,
  href?: string,
): EntityLinkOption | null {
  if (link.label === null) return null;
  return {
    id: link.id,
    label: link.label,
    dateLabel: link.date ? date(link.date) : null,
    ...(href ? { href } : {}),
  };
}

export function EncounterLinkPickers({
  modules,
  anchor,
  links,
  documentIds,
  labResultIds,
  episodeIds,
  onChange,
}: {
  modules: Partial<Record<ModuleKey, boolean>> | undefined;
  /** The visit's own date: where every picker opens. */
  anchor: string | null;
  /**
   * What the visit links already, as its own read names it (an edit). Their
   * chips show whether or not a loaded page holds them.
   */
  links?: EncounterLinksDTO | null;
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
  const pivot = pickerPivot(anchor);

  // The vault around the visit's date, suggestions on top — see
  // `useVaultDocumentOptions`.
  const documents = useVaultDocumentOptions({
    enabled: documentsOn,
    anchor,
  });

  const labs = useLinkPickerPages<LabPickerResult>({
    enabled: labsOn,
    pivot,
    queryKey: queryKeys.labResultsPicker,
    fetchPage: fetchLabPage,
  });

  const episodes = useLinkPickerPages<IllnessEpisodeDTO>({
    enabled: illnessOn,
    pivot,
    queryKey: queryKeys.illnessEpisodesPicker,
    fetchPage: fetchEpisodePage,
  });

  const known = useMemo(() => {
    const date = (iso: string) => format.date(iso);
    const keep = (
      option: EntityLinkOption | null,
    ): option is EntityLinkOption => option !== null;
    return {
      documents: (links?.documents ?? [])
        .map((link) => linkedDocumentOption(link, date))
        .filter(keep),
      labResults: (links?.labResults ?? [])
        .map((link) => linkedOption(link, date))
        .filter(keep),
      conditions: (links?.conditions ?? [])
        .map((link) =>
          linkedOption(link, date, `/illness/${encodeURIComponent(link.id)}`),
        )
        .filter(keep),
    };
  }, [links, format]);

  if (!documentsOn && !labsOn && !illnessOn) return null;

  // Labs group by sample date + panel: "Blutbild · 12.05.2026", the analyte
  // underneath. A visit links the whole panel from a day in one "select all".
  const labOptions: EntityLinkOption[] = labs.items.map((result) => {
    const dayLabel = format.date(result.takenAt);
    const groupLabel = result.panel ? `${result.panel}, ${dayLabel}` : dayLabel;
    return {
      id: result.id,
      label: result.analyte,
      dateLabel: dayLabel,
      group: {
        key: `${result.takenAt.slice(0, 10)}|${result.panel ?? ""}`,
        label: groupLabel,
      },
    };
  });

  // Episodes stay flat, newest onset first.
  const episodeOptions: EntityLinkOption[] = episodes.items.map((episode) => ({
    id: episode.id,
    label: episode.label,
    dateLabel: episode.onsetAt ? format.date(episode.onsetAt) : null,
    href: `/illness/${encodeURIComponent(episode.id)}`,
  }));

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
          server={documents.server}
          knownOptions={known.documents}
          searchPlaceholder={t("links.picker.searchPlaceholder")}
          emptyLabel={t("encounters.form.linkNothingToOffer")}
          extraAction={
            // The form owns its selection and replaces the visit's links on
            // save, so imported documents join the selection rather than
            // being linked on the server.
            <ImportFromSourceButton
              className="min-h-9"
              onImported={(ids) =>
                onChange({ documentIds: mergeIds(documentIds, ids) })
              }
            />
          }
        />
      ) : null}

      {labsOn ? (
        <EntityLinkPicker
          icon={FlaskConical}
          title={t("encounters.form.linkLabResults")}
          slot="encounter-link-labs"
          pending={labs.pending}
          error={labs.error}
          errorLabel={t("links.picker.loadError")}
          onRetry={labs.retry}
          selected={labResultIds}
          onChange={(ids) => onChange({ labResultIds: ids })}
          options={labOptions}
          server={serverPagingFrom(labs)}
          knownOptions={known.labResults}
          searchPlaceholder={t("links.picker.searchPlaceholder")}
          emptyLabel={t("encounters.form.linkNothingToOffer")}
        />
      ) : null}

      {illnessOn ? (
        <EntityLinkPicker
          icon={Stethoscope}
          title={t("encounters.form.linkConditions")}
          slot="encounter-link-conditions"
          pending={episodes.pending}
          error={episodes.error}
          errorLabel={t("links.picker.loadError")}
          onRetry={episodes.retry}
          selected={episodeIds}
          onChange={(ids) => onChange({ episodeIds: ids })}
          options={episodeOptions}
          server={serverPagingFrom(episodes)}
          knownOptions={known.conditions}
          searchPlaceholder={t("links.picker.searchPlaceholder")}
          emptyLabel={t("encounters.form.linkNothingToOffer")}
        />
      ) : null}
    </div>
  );
}
