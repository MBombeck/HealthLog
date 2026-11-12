"use client";

/**
 * The vault document picker sheet: a `ResponsiveSheet` (bottom sheet on
 * phones) with a debounced search over the person's own vault (the same
 * recall path as the vault page, one page of 50 matches with a line that
 * says when more exist, the search input as the way to an older document)
 * and one toggle row per document.
 *
 * Two pickers used to carry this whole body as copies: linking documents to
 * an illness episode (each toggle writes at once) and choosing documents for
 * a share link (the choice is local state, capped, posted with the link).
 * What a toggle means stays with each caller; the list, the search, the rows
 * and their states live here once.
 */
import { useQuery } from "@tanstack/react-query";
import { Check, Search } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useDocumentDate } from "@/components/documents/use-document-date";
import { ListCapNotice } from "@/components/ui/list-cap-notice";
import { DOCUMENT_KIND_ICONS } from "@/components/documents/document-kind-meta";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import type { InboundDocumentDto } from "@/lib/validations/inbound-documents";

interface ListPage {
  documents: InboundDocumentDto[];
  nextCursor: string | null;
}

export function DocumentPickerSheet({
  open,
  onOpenChange,
  title,
  description,
  searchPlaceholder,
  emptyLabel,
  isPicked,
  onToggle,
  isDisabled,
  notice,
  footer,
  listTestId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  searchPlaceholder: string;
  emptyLabel: string;
  isPicked: (doc: InboundDocumentDto) => boolean;
  /** `title` is the row's display title (title, filename or "untitled"). */
  onToggle: (doc: InboundDocumentDto, title: string, picked: boolean) => void;
  isDisabled?: (doc: InboundDocumentDto, picked: boolean) => boolean;
  /** A status line above the list (the share cap). */
  notice?: ReactNode;
  footer?: ReactNode;
  listTestId?: string;
}) {
  const { t } = useTranslations();
  const documentDate = useDocumentDate();

  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState("");

  // 200 ms debounce, matching the vault's search feel.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );
  const onSearchChange = (value: string) => {
    setSearchDraft(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setQuery(value.trim()), 200);
  };

  const list = useQuery({
    queryKey: queryKeys.inboundDocumentPicker(query),
    enabled: open,
    queryFn: () => {
      const sp = new URLSearchParams();
      if (query) sp.set("q", query);
      sp.set("sort", "documentDate");
      sp.set("order", "desc");
      sp.set("limit", "50");
      return apiGet<ListPage>(`/api/documents/inbound?${sp.toString()}`);
    },
  });

  const documents = list.data?.documents ?? [];
  // More match than one page: say so, and that the search reaches the rest.
  const cut = Boolean(list.data?.nextCursor);

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={footer}
    >
      <div className="space-y-3">
        <div className="relative">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            type="search"
            value={searchDraft}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="pl-9"
          />
        </div>

        {notice}

        {list.isPending && open ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : list.isError ? (
          <QueryErrorRow
            error={list.error}
            message={t("documents.list.loadError")}
            onRetry={() => list.refetch()}
          />
        ) : documents.length === 0 ? (
          <EmptyState variant="plain" size="compact" title={emptyLabel} />
        ) : (
          <ul
            className="max-h-[50vh] space-y-1.5 overflow-y-auto overscroll-contain"
            data-testid={listTestId}
          >
            {documents.map((doc) => {
              const picked = isPicked(doc);
              const rowTitle =
                doc.title ?? doc.filename ?? t("documents.card.untitled");
              const Icon = DOCUMENT_KIND_ICONS[doc.kind];
              const disabled = isDisabled?.(doc, picked) ?? false;
              return (
                <li key={doc.id}>
                  <button
                    type="button"
                    aria-pressed={picked}
                    disabled={disabled}
                    onClick={() => onToggle(doc, rowTitle, picked)}
                    className={cn(
                      "border-border hover:bg-muted/50 flex w-full items-center gap-3 rounded-lg border p-3 text-left",
                      "focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none",
                      picked && "border-primary/40 bg-primary/5",
                      disabled && "cursor-not-allowed opacity-50",
                    )}
                  >
                    <Icon
                      className="text-foreground size-5 shrink-0"
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {rowTitle}
                      </span>
                      <span className="text-muted-foreground block text-xs">
                        {documentDate(doc)}
                      </span>
                    </span>
                    <Check
                      className={cn(
                        "text-primary size-4 shrink-0",
                        picked ? "opacity-100" : "opacity-0",
                      )}
                      aria-hidden
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <DocumentPickerCapNotice
          cut={cut && !list.isError}
          count={documents.length}
          searching={query !== ""}
        />
      </div>
    </ResponsiveSheet>
  );
}

/**
 * The line under a picker list cut at one page: the search reaches the rest,
 * and while one runs, a narrower one does. Shared by the vault picker and
 * the Coach's attachment picker.
 */
export function DocumentPickerCapNotice({
  cut,
  count,
  searching,
}: {
  cut: boolean;
  count: number;
  searching: boolean;
}) {
  const { t } = useTranslations();
  return (
    <ListCapNotice
      cap={{ truncated: cut, limit: count }}
      message={t(
        searching
          ? "documents.picker.cappedSearching"
          : "documents.picker.capped",
        { count: String(count) },
      )}
    />
  );
}
