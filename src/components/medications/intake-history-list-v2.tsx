"use client";

import { useQuery } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import Link from "next/link";
import {
  Loader2,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  History,
  Check,
  SkipForward,
} from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * v1.4.36 W4a — Lite intake-history surface.
 *
 * The 886-LoC v1 was retired in v1.4.28 (commit 8c81af10) with the
 * note "no other consumer". The standalone medication-history page
 * lost its dose timeline as a side effect — Marc reported the page
 * now shows only the heading for non-GLP-1 meds. This v2 restores a
 * read-only timeline for ALL medication kinds without the inline CRUD
 * the v1 carried (edit / delete still happen through the regular
 * medication-intake routes elsewhere).
 *
 * Contract:
 *  - Paginated 25/page via the existing `?limit=&offset=` query on
 *    `GET /api/medications/[id]/intake`. The route already supports
 *    `sortBy=takenAt|scheduledFor|createdAt|source` + `sortDir=asc|desc`.
 *  - v1.4.37 W3: filters server-side with `?status=completed` so the
 *    detail-page list shows only rows the user actually actioned
 *    (taken OR skipped). The ambiguous "missed / never confirmed"
 *    rows (`takenAt IS NULL AND skipped = false`) stay hidden here
 *    and remain visible on the calendar / today surfaces. This
 *    restores the v1 component's effective behaviour and fixes the
 *    bug where such rows rendered as "Eingenommen" with an empty
 *    leading column.
 *  - Sortable by `takenAt` (default) and `scheduledFor`. Click the
 *    header to toggle the direction; switching column resets to desc.
 *  - Status chip: green Check + "Eingenommen" for taken rows,
 *    outline SkipForward + "Übersprungen" for skipped rows. The
 *    component never labels a row both at once.
 *  - Source badge surfaces WEB / API / REMINDER / IMPORT using the
 *    existing `medications.source*` keys.
 *  - Empty state copy + CTA back to the daily intake page.
 *  - No edit-in-row, no delete buttons.
 */

type IntakeSource = "WEB" | "API" | "REMINDER" | "IMPORT";

interface IntakeEvent {
  id: string;
  medicationId: string;
  scheduledFor: string;
  takenAt: string | null;
  skipped: boolean;
  source: IntakeSource;
  createdAt: string;
}

interface IntakeListResponse {
  events: IntakeEvent[];
  meta: { total: number; limit: number; offset: number };
}

interface IntakeHistoryListV2Props {
  medicationId: string;
  /** Override the default page size — primarily for tests. */
  pageSize?: number;
}

type SortKey = "takenAt" | "scheduledFor";

const DEFAULT_PAGE_SIZE = 25;
/**
 * v1.4.37 W3 — pinned to "completed" for the detail-page surface so
 * planned / missed rows never leak into the table. Lifted to a
 * module-level constant so the queryKey stays stable across renders
 * and `setQueryData` in tests can pre-seed the same shape.
 */
const STATUS_FILTER = "completed";

export function IntakeHistoryListV2({
  medicationId,
  pageSize = DEFAULT_PAGE_SIZE,
}: IntakeHistoryListV2Props) {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslations();
  const formatters = useFormatters();

  const [sortBy, setSortBy] = useState<SortKey>("takenAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(0);

  const offset = page * pageSize;

  const { data, isLoading, isError } = useQuery<IntakeListResponse>({
    queryKey: queryKeys.medicationIntakeList(medicationId, {
      sortBy,
      sortDir,
      limit: pageSize,
      offset,
      status: STATUS_FILTER,
    }),
    queryFn: async () => {
      const params = new URLSearchParams({
        sortBy,
        sortDir,
        limit: String(pageSize),
        offset: String(offset),
        status: STATUS_FILTER,
      });
      const res = await fetch(
        `/api/medications/${medicationId}/intake?${params.toString()}`,
      );
      if (!res.ok) throw new Error("Failed to load intake history");
      return (await res.json()).data as IntakeListResponse;
    },
    enabled: isAuthenticated,
  });

  const sourceLabels: Record<IntakeSource, string> = useMemo(
    () => ({
      WEB: t("medications.sourceWeb"),
      API: t("medications.sourceApi"),
      REMINDER: t("medications.sourceReminder"),
      IMPORT: t("medications.sourceImport"),
    }),
    [t],
  );

  const total = data?.meta.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const events = data?.events ?? [];

  const toggleSort = (key: SortKey) => {
    if (key === sortBy) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortBy(key);
      setSortDir("desc");
    }
    setPage(0);
  };

  const sortIndicator = (key: SortKey) => {
    if (key !== sortBy) {
      return <ArrowUpDown className="ml-1 inline h-3 w-3 opacity-50" />;
    }
    return sortDir === "desc" ? (
      <ArrowDown className="ml-1 inline h-3 w-3" />
    ) : (
      <ArrowUp className="ml-1 inline h-3 w-3" />
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {t("medications.intakeHistory")}
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-4 md:pb-6">
        {isLoading ? (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="text-muted-foreground h-5 w-5 animate-spin motion-reduce:animate-none" />
          </div>
        ) : isError ? (
          <p className="text-destructive text-sm">
            {t("medications.loadFailed")}
          </p>
        ) : events.length === 0 ? (
          <EmptyState
            variant="plain"
            size="compact"
            icon={<History className="size-6" />}
            title={t("medications.intakeHistoryEmptyTitle")}
            description={t("medications.intakeHistoryEmptyDescription")}
            action={
              <Button asChild size="sm">
                <Link href="/medications">
                  {t("medications.intakeHistoryEmptyAction")}
                </Link>
              </Button>
            }
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <button
                      type="button"
                      onClick={() => toggleSort("takenAt")}
                      className="focus-visible:ring-ring inline-flex min-h-11 items-center rounded-md font-medium hover:underline focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none sm:min-h-9"
                      aria-label={t("medications.intakeHistorySortByTaken")}
                    >
                      {t("medications.intakeHistoryColTaken")}
                      {sortIndicator("takenAt")}
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      type="button"
                      onClick={() => toggleSort("scheduledFor")}
                      className="focus-visible:ring-ring inline-flex min-h-11 items-center rounded-md font-medium hover:underline focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none sm:min-h-9"
                      aria-label={t("medications.intakeHistorySortByScheduled")}
                    >
                      {t("medications.intakeHistoryColScheduled")}
                      {sortIndicator("scheduledFor")}
                    </button>
                  </TableHead>
                  <TableHead>
                    {t("medications.intakeHistoryColStatus")}
                  </TableHead>
                  <TableHead>
                    {t("medications.intakeHistoryColSource")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((event) => {
                  // v1.4.37 W3 — `status=completed` server filter
                  // guarantees that every row is either a taken or a
                  // skipped event. We derive the branch from the data
                  // itself rather than trusting a single `skipped`
                  // flag so a malformed row (e.g. `skipped:false` with
                  // `takenAt:null`, the v1.4.36 regression) never
                  // sneaks past as "Eingenommen".
                  const isTaken = !event.skipped && !!event.takenAt;
                  const isSkipped = event.skipped;
                  return (
                    <TableRow key={event.id}>
                      <TableCell className="text-sm">
                        {event.takenAt
                          ? formatters.dateTime(event.takenAt)
                          : "—"}
                      </TableCell>
                      <TableCell className="text-sm">
                        {formatters.dateTime(event.scheduledFor)}
                      </TableCell>
                      <TableCell>
                        {isTaken ? (
                          <Badge
                            variant="secondary"
                            className="gap-1 bg-green-500/20 text-xs text-green-400"
                          >
                            <Check aria-hidden="true" className="h-3 w-3" />
                            {t("medications.intakeHistoryStatusTaken")}
                          </Badge>
                        ) : isSkipped ? (
                          <Badge
                            variant="outline"
                            className="text-muted-foreground gap-1 text-xs"
                          >
                            <SkipForward
                              aria-hidden="true"
                              className="h-3 w-3"
                            />
                            {t("medications.intakeHistoryStatusSkipped")}
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {sourceLabels[event.source] ?? event.source}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>

            {totalPages > 1 && (
              <div className="text-muted-foreground mt-3 flex items-center justify-between text-xs">
                <span>
                  {t("medications.intakeHistoryPageInfo", {
                    page: page + 1,
                    total: totalPages,
                    count: total,
                  })}
                </span>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 sm:min-h-9"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                  >
                    {t("medications.intakeHistoryPrev")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 sm:min-h-9"
                    onClick={() =>
                      setPage((p) => Math.min(totalPages - 1, p + 1))
                    }
                    disabled={page >= totalPages - 1}
                  >
                    {t("medications.intakeHistoryNext")}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
