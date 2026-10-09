"use client";

/**
 * The document picker (#1038): search a connected Paperless-ngx or Papra by
 * document name, narrow by tag and date, tick the documents to bring over,
 * import them.
 *
 * Name first, because that is how the person looks for a letter: the search
 * field opens focused and debounces into the source's own name search. Tag and
 * date are filters beside it, not the entry point. Each result says what
 * HealthLog already holds under that source key: already imported, deleted
 * here (not offered again: a deletion was a decision), or new.
 *
 * The import runs one document per request, in order, so every row can show
 * its own progress and result, and one failure does not hide the others. A
 * refusal that will answer every following document the same way (the hourly
 * upload allowance, a full vault, a refused token) stops the run and says so.
 *
 * Where it was opened from decides what an import does besides storing:
 *
 *   - `link`: the record already exists (a condition's page), so the server
 *     files the document against it as part of the import;
 *   - `onImported`: a form that owns its selection (a visit, a vaccination)
 *     gets the new ids and adds them itself. Linking on the server there would
 *     be undone by the form's own save, which replaces its links.
 *
 * With either, a document already in HealthLog can be picked too: it is not
 * stored twice, it is linked or handed to the form.
 */
import { useCalendarDate } from "@/hooks/use-calendar-date";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Check,
  CircleAlert,
  CircleCheck,
  Loader2,
  Search,
  SearchX,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { TagChip } from "@/components/ui/tag-chip";
import { apiGet, apiPost } from "@/lib/api/api-fetch";
import {
  DOCUMENT_PICKER_MAX_SELECTION,
  slugForSystem,
  type DocumentImportOutcome,
  type DocumentPickerLinkKind,
  type DocumentPickerSystem,
  type DocumentSourceImportDto,
  type DocumentSourceResultDto,
  type DocumentSourceSearchDto,
  type DocumentSourceTagDto,
} from "@/lib/documents/sources/types";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import type { InboundDocumentKindValue } from "@/lib/validations/inbound-documents";

import { WrittenOutcomeLine } from "@/components/outcome/written-outcome-line";
import type { WrittenOutcome } from "@/lib/outcome/written-outcome";

import { formatBytes } from "../vault-utils";
import {
  errorCodeOf,
  isStoppingError,
  sourceErrorMessage,
} from "./source-errors";
import { SegmentedChoice } from "./segmented-choice";
import { systemName } from "./use-document-sources";

export interface DocumentPickerLink {
  kind: DocumentPickerLinkKind;
  id: string;
}

export interface DocumentSourcePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Connected systems, in the order the switch shows them. */
  systems: DocumentPickerSystem[];
  /** File the imported documents against this existing record. */
  link?: DocumentPickerLink;
  /** Document type for everything imported (default OTHER). */
  kind?: InboundDocumentKindValue;
  /** Hand the vault ids to a form that links them on its own save. */
  onImported?: (documentIds: string[]) => void;
}

type RowRun =
  | { state: "waiting" }
  | { state: "working" }
  | { state: DocumentImportOutcome; linked: boolean }
  | { state: "failed"; message: string };

const SEARCH_DEBOUNCE_MS = 300;
const IMPORT_TIMEOUT_MS = 120_000;

export function DocumentSourcePicker({
  open,
  onOpenChange,
  systems,
  link,
  kind,
  onImported,
}: DocumentSourcePickerProps) {
  const { t, locale } = useTranslations();
  const calendarDate = useCalendarDate();
  const queryClient = useQueryClient();

  const [system, setSystem] = useState<DocumentPickerSystem | null>(null);
  const active =
    system && systems.includes(system) ? system : (systems[0] ?? null);
  const slug = active ? slugForSystem(active) : null;

  const [searchDraft, setSearchDraft] = useState("");
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [runs, setRuns] = useState<Map<string, RowRun>>(new Map());
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [stopMessage, setStopMessage] = useState<string | null>(null);
  const [atMax, setAtMax] = useState(false);
  /** The latest per-row result, for screen readers (aria-live below). */
  const [announcement, setAnnouncement] = useState("");

  // A new search or filter starts over: a selection made in one result list
  // must not ride along unseen into another, and a finished run's result
  // lines belong to the list they were made in.
  const startOver = () => {
    setSelected(new Map());
    setRuns(new Map());
    setFinished(false);
    setStopMessage(null);
    setAtMax(false);
  };

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
    debounceRef.current = setTimeout(() => {
      const next = value.trim();
      if (next !== q) {
        startOver();
        setQ(next);
      }
    }, SEARCH_DEBOUNCE_MS);
  };
  const filterSetter =
    (set: (value: string) => void) =>
    (value: string): void => {
      startOver();
      set(value);
    };

  const reset = () => {
    setSearchDraft("");
    setQ("");
    setTag("");
    setFrom("");
    setTo("");
    startOver();
  };

  const switchSystem = (next: DocumentPickerSystem) => {
    if (next === active || running) return;
    reset();
    setSystem(next);
  };

  const tags = useQuery({
    queryKey: queryKeys.documentSourceTags(slug ?? ""),
    enabled: open && slug !== null,
    queryFn: () =>
      apiGet<{ tags: DocumentSourceTagDto[] }>(
        `/api/documents/sources/${slug}/tags`,
      ),
    staleTime: 5 * 60_000,
  });

  const facets = {
    q,
    ...(tag ? { tag } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
  const rangeInvalid = Boolean(from && to && from > to);
  const search = useInfiniteQuery({
    queryKey: queryKeys.documentSourceSearch(slug ?? "", facets),
    enabled: open && slug !== null && !rangeInvalid,
    initialPageParam: 1,
    queryFn: ({ pageParam }) => {
      const sp = new URLSearchParams({ page: String(pageParam) });
      if (q) sp.set("q", q);
      if (tag) sp.set("tag", tag);
      if (from) sp.set("from", from);
      if (to) sp.set("to", to);
      return apiGet<DocumentSourceSearchDto>(
        `/api/documents/sources/${slug}/search?${sp.toString()}`,
      );
    },
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
    staleTime: 30_000,
  });

  const results = useMemo(() => {
    const seen = new Set<string>();
    const out: DocumentSourceResultDto[] = [];
    for (const page of search.data?.pages ?? []) {
      for (const row of page.results) {
        if (seen.has(row.sourceId)) continue;
        seen.add(row.sourceId);
        out.push(row);
      }
    }
    return out;
  }, [search.data]);

  // An already imported document is worth picking only when the pick does
  // something with it: link it, or hand it to the form.
  const canTakeImported = Boolean(link || onImported);
  const selectable = (row: DocumentSourceResultDto) =>
    row.state === "new" || (row.state === "imported" && canTakeImported);

  const toggle = (row: DocumentSourceResultDto) => {
    if (running || finished || !selectable(row)) return;
    const next = new Map(selected);
    if (next.has(row.sourceId)) {
      next.delete(row.sourceId);
      setAtMax(false);
    } else if (next.size < DOCUMENT_PICKER_MAX_SELECTION) {
      next.set(row.sourceId, row.title);
    } else {
      // Said rather than silently ignored: the tick that did not appear.
      setAtMax(true);
      return;
    }
    setSelected(next);
  };

  async function runImport() {
    if (!slug || selected.size === 0) return;
    setRunning(true);
    setStopMessage(null);
    const order = [...selected.keys()];
    setRuns(new Map(order.map((id) => [id, { state: "waiting" }])));
    const handed: string[] = [];
    const mark = (id: string, run: RowRun) => {
      setRuns((prev) => new Map(prev).set(id, run));
      const title = selected.get(id) ?? id;
      const said = runLabel(t, run);
      if (said) setAnnouncement(`${title}: ${said}`);
    };

    for (const sourceId of order) {
      mark(sourceId, { state: "working" });
      try {
        const result = await apiPost<DocumentSourceImportDto>(
          `/api/documents/sources/${slug}/import`,
          {
            sourceId,
            ...(kind ? { kind } : {}),
            ...(link ? { link } : {}),
          },
          // The server may take up to a minute to fetch a large file from
          // the source; the default 15 s client timeout would abandon it.
          { signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS) },
        );
        mark(sourceId, { state: result.outcome, linked: result.linked });
        if (result.outcome !== "deleted" && result.documentId) {
          handed.push(result.documentId);
        }
      } catch (err) {
        const code = errorCodeOf(err);
        const message = sourceErrorMessage(t, code);
        mark(sourceId, { state: "failed", message });
        if (isStoppingError(code)) {
          setStopMessage(message);
          break;
        }
      }
    }

    setRunning(false);
    setFinished(true);
    setSelected(new Map());
    // The vault, its pickers and the record's own lists read documents
    // through the `["documents"]` prefix; the picker's states through its own.
    void invalidateKeys(queryClient, [
      queryKeys.documents(),
      queryKeys.documentSources(),
    ]);
    if (handed.length > 0) onImported?.(handed);
  }

  const counts = useMemo(() => {
    let imported = 0;
    let present = 0;
    let failed = 0;
    for (const run of runs.values()) {
      if (run.state === "imported") imported += 1;
      else if (run.state === "duplicate" || run.state === "deleted")
        present += 1;
      else if (run.state === "failed") failed += 1;
    }
    return { imported, present, failed };
  }, [runs]);

  const name = active ? systemName(active) : "";
  const hasFilters = Boolean(tag || from || to);

  const footer = (
    <div className="flex w-full items-center justify-between gap-3">
      <p
        className="text-muted-foreground min-w-0 text-xs"
        data-slot="document-source-selection"
      >
        {finished
          ? null
          : running
            ? t("documents.sourcePicker.importing")
            : t("documents.sourcePicker.selectedCount", {
                count: selected.size,
                max: DOCUMENT_PICKER_MAX_SELECTION,
              })}
      </p>
      {finished ? (
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
            onClick={startOver}
            data-slot="document-source-pick-more"
          >
            {t("documents.sourcePicker.pickMore")}
          </Button>
          <Button
            type="button"
            size="sm"
            className="min-h-11 sm:min-h-9"
            onClick={() => onOpenChange(false)}
          >
            {t("documents.sourcePicker.done")}
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          size="sm"
          className="min-h-11 shrink-0 sm:min-h-9"
          disabled={running || selected.size === 0}
          onClick={() => void runImport()}
          data-slot="document-source-import"
        >
          {running ? (
            <Loader2
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          ) : null}
          {t("documents.sourcePicker.importAction", { count: selected.size })}
        </Button>
      )}
    </div>
  );

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={(next) => {
        // A run in progress finishes before the sheet can close; its rows
        // are the only place the outcome is shown.
        if (!next && running) return;
        if (!next) reset();
        onOpenChange(next);
      }}
      title={t("documents.sourcePicker.title", { name })}
      description={t("documents.sourcePicker.description")}
      contentWidth="lg"
      footer={footer}
    >
      <div className="space-y-3" data-slot="document-source-picker">
        {systems.length > 1 && active ? (
          <SegmentedChoice
            options={systems}
            value={active}
            onChange={switchSystem}
            label={t("documents.sourcePicker.sourceLabel")}
            disabled={running}
            renderOption={systemName}
          />
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="document-source-search">
            {t("documents.sourcePicker.searchLabel")}
          </Label>
          <div className="relative">
            <Search
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
              aria-hidden
            />
            <Input
              id="document-source-search"
              type="search"
              autoFocus
              value={searchDraft}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={t("documents.sourcePicker.searchPlaceholder")}
              className="pl-9"
              maxLength={200}
              autoComplete="off"
              data-slot="document-source-search"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="col-span-2 space-y-1.5 sm:col-span-1">
            <Label htmlFor="document-source-tag">
              {t("documents.sourcePicker.tagLabel")}
            </Label>
            <NativeSelect
              id="document-source-tag"
              value={tag}
              onChange={(e) => filterSetter(setTag)(e.target.value)}
              disabled={tags.isPending && !tags.isError}
            >
              <option value="">{t("documents.sourcePicker.tagAny")}</option>
              {(tags.data?.tags ?? []).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="document-source-from">
              {t("documents.sourcePicker.fromLabel")}
            </Label>
            <DateField
              id="document-source-from"
              value={from}
              onChange={filterSetter(setFrom)}
              max={to || undefined}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="document-source-to">
              {t("documents.sourcePicker.toLabel")}
            </Label>
            <DateField
              id="document-source-to"
              value={to}
              onChange={filterSetter(setTo)}
              min={from || undefined}
            />
          </div>
        </div>
        {hasFilters ? (
          <button
            type="button"
            onClick={() => {
              startOver();
              setTag("");
              setFrom("");
              setTo("");
            }}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex min-h-8 items-center gap-1 rounded-sm text-xs underline-offset-2 hover:underline focus-visible:ring-[3px] focus-visible:outline-none"
          >
            <X className="size-3.5" aria-hidden />
            {t("documents.sourcePicker.clearFilters")}
          </button>
        ) : null}

        {finished ? (
          <div className="space-y-1">
            <WrittenOutcomeLine
              outcome={runOutcome(counts)}
              message={t("documents.sourcePicker.summary", counts)}
              testId="document-source-summary"
            />
            <p className="text-muted-foreground text-xs">
              {t("documents.sourcePicker.finishedHint")}
            </p>
          </div>
        ) : null}

        {atMax ? (
          <p
            role="status"
            className="text-muted-foreground text-xs"
            data-slot="document-source-at-max"
          >
            {t("documents.sourcePicker.maxReached", {
              max: DOCUMENT_PICKER_MAX_SELECTION,
            })}
          </p>
        ) : null}

        {/* Each row's result as it lands, for a screen reader. */}
        <div aria-live="polite" className="sr-only">
          {announcement}
        </div>

        {stopMessage ? (
          <p
            role="alert"
            className="text-destructive text-sm"
            data-slot="document-source-stopped"
          >
            {t("documents.sourcePicker.stopped", { reason: stopMessage })}
          </p>
        ) : null}

        {rangeInvalid ? (
          <p role="alert" className="text-destructive text-sm">
            {t("documents.sourcePicker.rangeInvalid")}
          </p>
        ) : search.isPending ? (
          <div className="space-y-2" data-slot="document-source-loading">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-lg" />
            ))}
          </div>
        ) : search.isError ? (
          <QueryErrorRow
            message={sourceErrorMessage(t, errorCodeOf(search.error))}
            onRetry={() => void search.refetch()}
            slot="document-source-error"
          />
        ) : results.length === 0 ? (
          <EmptyState
            variant="plain"
            size="compact"
            icon={<SearchX className="size-6" aria-hidden />}
            title={
              q || hasFilters
                ? t("documents.sourcePicker.noMatch")
                : t("documents.sourcePicker.empty", { name })
            }
            description={
              q || hasFilters
                ? t("documents.sourcePicker.noMatchHint")
                : undefined
            }
          />
        ) : (
          <ul
            className="max-h-[45vh] space-y-1.5 overflow-y-auto overscroll-contain"
            data-slot="document-source-results"
          >
            {results.map((row) => {
              const on = selected.has(row.sourceId);
              const run = runs.get(row.sourceId);
              const allowed = selectable(row);
              const meta = [
                row.date ? calendarDate(row.date) : null,
                row.sizeBytes !== null
                  ? formatBytes(row.sizeBytes, locale)
                  : null,
              ]
                .filter(Boolean)
                .join(", ");
              return (
                <li key={row.sourceId}>
                  <button
                    type="button"
                    aria-pressed={on}
                    aria-disabled={!allowed || running || finished}
                    onClick={() => toggle(row)}
                    data-slot="document-source-result"
                    data-state={row.state}
                    className={cn(
                      "border-border flex min-h-11 w-full items-start gap-3 rounded-lg border p-3 text-left",
                      "focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none",
                      allowed && !running && !finished && "hover:bg-muted/50",
                      on && "border-primary/40 bg-primary/5",
                      // A row that just ran keeps full contrast: its result is
                      // the thing to read.
                      // After a run, the rows it did not touch step back:
                      // the ones with a result are what to read now.
                      ((!allowed && !run) || (finished && !run)) &&
                        "opacity-50",
                    )}
                  >
                    <Check
                      className={cn(
                        "text-primary mt-0.5 size-4 shrink-0",
                        on ? "opacity-100" : "opacity-0",
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="block truncate text-sm font-medium">
                        {row.title}
                      </span>
                      {meta ? (
                        <span className="text-muted-foreground block text-xs">
                          {meta}
                        </span>
                      ) : null}
                      {row.tags.length > 0 ? (
                        <span className="flex flex-wrap gap-1">
                          {row.tags.slice(0, 6).map((name) => (
                            <TagChip key={name}>{name}</TagChip>
                          ))}
                        </span>
                      ) : null}
                      {run ? <RunLine run={run} /> : null}
                    </span>
                    {row.state !== "new" && !run ? (
                      <Badge variant="outline" className="shrink-0">
                        {row.state === "imported"
                          ? t("documents.sourcePicker.stateImported")
                          : t("documents.sourcePicker.stateDeleted")}
                      </Badge>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {search.hasNextPage && !search.isError ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 w-full sm:min-h-9"
            disabled={search.isFetchingNextPage}
            onClick={() => void search.fetchNextPage()}
          >
            {search.isFetchingNextPage ? (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden
              />
            ) : null}
            {t("documents.sourcePicker.loadMore")}
          </Button>
        ) : null}
      </div>
    </ResponsiveSheet>
  );
}

/** How the run went, in the shared outcome vocabulary. */
function runOutcome(counts: {
  imported: number;
  present: number;
  failed: number;
}): WrittenOutcome {
  const held = counts.imported + counts.present;
  if (counts.failed === 0) return held > 0 ? "success" : "empty";
  return held > 0 ? "partial" : "failed";
}

/** A row's result in words, or null while it has none yet. */
function runLabel(
  t: (key: string, params?: Record<string, string | number>) => string,
  run: RowRun,
): string | null {
  switch (run.state) {
    case "waiting":
    case "working":
      return null;
    case "failed":
      return run.message;
    case "deleted":
      return t("documents.sourcePicker.result.deleted");
    case "imported":
      return run.linked
        ? t("documents.sourcePicker.result.importedLinked")
        : t("documents.sourcePicker.result.imported");
    case "duplicate":
      return run.linked
        ? t("documents.sourcePicker.result.duplicateLinked")
        : t("documents.sourcePicker.result.duplicate");
  }
}

/** One row's progress or result, under its title. */
function RunLine({ run }: { run: RowRun }) {
  const { t } = useTranslations();
  switch (run.state) {
    case "waiting":
      return (
        <span className="text-muted-foreground block text-xs">
          {t("documents.sourcePicker.result.waiting")}
        </span>
      );
    case "working":
      return (
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <Loader2
            className="size-3.5 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
          {t("documents.sourcePicker.result.working")}
        </span>
      );
    case "failed":
      return (
        <span
          className="text-destructive flex items-start gap-1.5 text-xs"
          data-slot="document-source-run-failed"
        >
          <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          {run.message}
        </span>
      );
    case "deleted":
      return (
        <span className="text-muted-foreground block text-xs">
          {t("documents.sourcePicker.result.deleted")}
        </span>
      );
    case "imported":
    case "duplicate":
      return (
        <span
          className="text-success flex items-center gap-1.5 text-xs"
          data-slot="document-source-run-done"
        >
          <CircleCheck className="size-3.5 shrink-0" aria-hidden />
          {run.state === "imported"
            ? run.linked
              ? t("documents.sourcePicker.result.importedLinked")
              : t("documents.sourcePicker.result.imported")
            : run.linked
              ? t("documents.sourcePicker.result.duplicateLinked")
              : t("documents.sourcePicker.result.duplicate")}
        </span>
      );
  }
}
