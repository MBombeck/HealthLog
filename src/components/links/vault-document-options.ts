"use client";

/**
 * The vault as a link-picker option list, with the documents near the
 * record's own date on top.
 *
 * The visit and vaccination forms used to fetch their document options with a
 * page size the list route refuses (`limit=200` against a ceiling of 100). The
 * 422 read as an empty list, so the picker said "No documents yet." to a
 * person with a full vault, and the only way a scan ever got attached was the
 * ±7-day suggestion offered at upload. A childhood record covering eight doses
 * from one sheet of paper could therefore be filed against exactly one of
 * them.
 *
 * Now the whole vault is offered, paged through at the route's own ceiling,
 * and a read failure says so instead of pretending the vault is empty. The
 * documents dated within the same ±{@link ENCOUNTER_SUGGEST_WINDOW_DAYS}-day
 * window the upload suggestion uses stay on top under their own heading, so
 * the common case is still one tap; everything else follows, grouped by month
 * and searchable.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import type { EntityLinkOption } from "@/components/links/entity-link-picker";
import { apiGet } from "@/lib/api/api-fetch";
import { ENCOUNTER_SUGGEST_WINDOW_DAYS } from "@/lib/encounters/suggest-window";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  DOCUMENT_LIST_MAX_LIMIT,
  type InboundDocumentDto,
} from "@/lib/validations/inbound-documents";

/**
 * How many pages the picker walks. At the route's ceiling of 100 that is a
 * thousand documents, past which the vault's own search is the better tool.
 */
const VAULT_PICKER_MAX_PAGES = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The fields the option list reads off a document. */
export type VaultDocument = Pick<
  InboundDocumentDto,
  "id" | "title" | "filename" | "documentDate" | "reportDate" | "createdAt"
>;

interface ListPage {
  documents: InboundDocumentDto[];
  nextCursor: string | null;
}

/** Walk the vault newest filing date first, at the route's own page ceiling. */
export async function fetchWholeVault(): Promise<VaultDocument[]> {
  const documents: VaultDocument[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < VAULT_PICKER_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      sort: "documentDate",
      order: "desc",
      limit: String(DOCUMENT_LIST_MAX_LIMIT),
    });
    if (cursor) params.set("cursor", cursor);
    const result: ListPage = await apiGet<ListPage>(
      `/api/documents/inbound?${params.toString()}`,
    );
    documents.push(...result.documents);
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return documents;
}

/**
 * Is a document dated within the suggestion window of the record's anchor?
 * Day-granular and inclusive on both edges, like the upload suggestion. A
 * document with no date of its own is never "near" anything.
 */
export function isNearAnchor(
  documentDay: string | null,
  anchorIso: string | null,
): boolean {
  if (!documentDay || !anchorIso) return false;
  const day = Date.parse(`${documentDay.slice(0, 10)}T00:00:00.000Z`);
  const anchor = Date.parse(`${anchorIso.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(day) || Number.isNaN(anchor)) return false;
  return Math.abs(day - anchor) <= ENCOUNTER_SUGGEST_WINDOW_DAYS * DAY_MS;
}

/**
 * Build the option list: suggestions first, under one heading, then the rest
 * of the vault in the route's order (newest filing date first), by month.
 *
 * `labels` carries the already-localised strings, so this stays a pure
 * function a test can call without a provider.
 */
export function documentOptionsWithSuggestions(
  documents: readonly VaultDocument[],
  anchorIso: string | null,
  labels: {
    suggested: string;
    month: (iso: string) => string;
    date: (iso: string) => string;
  },
): EntityLinkOption[] {
  const suggested: EntityLinkOption[] = [];
  const rest: EntityLinkOption[] = [];
  for (const doc of documents) {
    const own = doc.documentDate ?? doc.reportDate;
    const date = own ?? doc.createdAt;
    const base = {
      id: doc.id,
      label: doc.title ?? doc.filename ?? doc.id,
      dateLabel: date ? labels.date(date) : null,
      // The vault opens a document's sheet from `?doc=`.
      href: `/documents?doc=${encodeURIComponent(doc.id)}`,
    };
    if (isNearAnchor(own, anchorIso)) {
      suggested.push({
        ...base,
        group: { key: "suggested", label: labels.suggested },
      });
    } else {
      rest.push({
        ...base,
        group: date
          ? { key: date.slice(0, 7), label: labels.month(date) }
          : null,
      });
    }
  }
  return [...suggested, ...rest];
}

/**
 * The picker's data: the whole vault as options, the suggestion group on top
 * when the record has a date, and the query state an error row needs.
 */
export function useVaultDocumentOptions({
  enabled,
  anchor,
}: {
  enabled: boolean;
  /** The record's own date (ISO), or null when it has none yet. */
  anchor: string | null;
}) {
  const { t } = useTranslations();
  const format = useFormatters();
  const query = useQuery({
    queryKey: queryKeys.inboundDocumentVaultPicker(),
    enabled,
    queryFn: fetchWholeVault,
  });

  const options = useMemo(
    () =>
      documentOptionsWithSuggestions(query.data ?? [], anchor, {
        suggested: t("links.picker.suggested"),
        month: (iso) => `${format.monthShort(iso)} ${iso.slice(0, 4)}`,
        date: (iso) => format.date(iso),
      }),
    [query.data, anchor, t, format],
  );

  return {
    options,
    pending: query.isPending,
    error: query.isError,
    retry: () => void query.refetch(),
  };
}
