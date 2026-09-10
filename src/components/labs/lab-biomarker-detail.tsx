"use client";

import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ArrowRight,
  FlaskConical,
  FolderOpen,
  ListOrdered,
  Pencil,
  Plus,
} from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/hooks/use-auth";
import { DeleteButton } from "@/components/data-list";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { InsightStatusCard } from "@/components/insights/insight-status-card";
import { MetricStatStrip } from "@/components/insights/metric-stat-strip";
import { useInsightBiomarkerAssessment } from "@/hooks/use-insight-status";
import { useMounted } from "@/hooks/use-mounted";
import { apiDelete, apiGet } from "@/lib/api/api-fetch";
import { summarize, type DataSummary } from "@/lib/analytics/trends";
import { BIOMARKER_CATALOG } from "@/lib/labs/biomarker-catalog";
import { useTranslations } from "@/lib/i18n/context";
import {
  getFallbackMessages,
  loadMessages,
  type MessageBundle,
} from "@/lib/i18n/load-locale";
import { resolveKey } from "@/lib/i18n/resolve-key";
import { queryKeys } from "@/lib/query-keys";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import { ChartErrorBoundary } from "@/components/charts/chart-error-state";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { importWithRetry } from "@/lib/retry-import";

import { BiomarkerForm } from "./biomarker-form";
import { LabForm } from "./lab-form";
import type {
  BiomarkerDto,
  LabResultDto,
  LabResultListResponse,
} from "./types";

// v1.18.11 (W5 perf) — defer the recharts biomarker chart through
// `next/dynamic` so recharts is off `/labs/[biomarkerId]`'s first-load JS.
// The chart only paints once the reading list resolves; the `<ChartSkeleton>`
// loading shell matches the in-card chart footprint so the layout is stable.
const LabBiomarkerChartLazy = dynamic(
  () =>
    importWithRetry(() => import("@/components/charts/chart-runtime")).then(
      (mod) => ({
        default: mod.LabBiomarkerChart,
      }),
    ),
  { ssr: false, loading: () => <ChartSkeleton /> },
);
function LabBiomarkerChart(
  props: ComponentProps<typeof LabBiomarkerChartLazy>,
) {
  return (
    <ChartErrorBoundary>
      <LabBiomarkerChartLazy {...props} />
    </ChartErrorBoundary>
  );
}

// Page size for the offset-paginated reading feed. The server caps a single
// read at 500 (`listLabResultsSchema`); this stays well under that and keeps
// the first paint light, with "Load more" pulling subsequent pages.
const READINGS_PAGE_SIZE = 200;

/**
 * v1.18.1 — per-biomarker detail: heading + current-value badge, the proper
 * dashboard-style chart with the reference band, and the editable reading
 * history. "Add value" pre-selects this biomarker so the user never re-picks
 * it. Mirrors the measurement-detail layout.
 */
export function LabBiomarkerDetail({ biomarkerId }: { biomarkerId: string }) {
  const { user } = useAuth();
  const { canWriteDomain, canManageDomain } = useRecordCapabilities();
  const canAddLab = canWriteDomain("labs");
  const canManageLabs = canManageDomain("labs");
  const { t, locale } = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();
  // v1.24 — the per-marker description used to live on the labs overview rows.
  // It belongs on the detail page beneath the heading (mirroring the metric
  // pages' explainer caption). Resolve the catalog slug from the marker name,
  // then fall back to the user's own `context`.
  //
  // v1.25.3 — key the lookup on BOTH the current-locale display name and the
  // English canonical name. A marker stores the catalog name as it read at
  // creation time (`biomarker-form` writes `t("labs.catalog.<slug>")`), so a
  // marker minted under the English default and then viewed in another locale
  // never matched a map built only from the current locale's names — the rich
  // description silently fell through to the generic line. The English bundle
  // resolves through `getFallbackMessages()` (already in hand on the server
  // and for EN sessions; lazily fetched below otherwise — the EN catalog is
  // no longer a static every-route import), so adding its names makes
  // resolution independent of the locale the marker was created in.
  const [enBundle, setEnBundle] = useState<MessageBundle | undefined>(
    getFallbackMessages,
  );
  useEffect(() => {
    if (enBundle) return;
    let cancelled = false;
    void loadMessages("en")
      .then((loaded) => {
        if (!cancelled) setEnBundle(loaded);
      })
      .catch(() => {
        // Offline — the current-locale names still resolve; only markers
        // minted under another locale keep the generic description.
      });
    return () => {
      cancelled = true;
    };
  }, [enBundle]);
  const slugByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const seed of BIOMARKER_CATALOG) {
      const localized = t(`labs.catalog.${seed.slug}`).trim().toLowerCase();
      if (localized) map.set(localized, seed.slug);
      const canonical = enBundle
        ? resolveKey(enBundle, `labs.catalog.${seed.slug}`)
            ?.trim()
            .toLowerCase()
        : undefined;
      if (canonical && !map.has(canonical)) map.set(canonical, seed.slug);
    }
    return map;
  }, [t, enBundle]);
  const [addOpen, setAddOpen] = useState(false);
  // Sticky-footer slot for the add-value sheet (the form portals here).
  const [addFooterEl, setAddFooterEl] = useState<HTMLDivElement | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editFooterEl, setEditFooterEl] = useState<HTMLDivElement | null>(null);

  const {
    data: marker,
    isError: markerError,
    refetch: refetchMarker,
  } = useQuery({
    queryKey: queryKeys.biomarkerDetail(biomarkerId),
    queryFn: () => apiGet<BiomarkerDto>(`/api/biomarkers/${biomarkerId}`),
  });

  // v1.25 — offset-paginated reading feed. The page no longer fetches a single
  // `limit=500` window (which silently truncated a marker once it crossed 500
  // readings); it loads a page at a time and a "Load more" control reveals the
  // rest. The chart + stat strip render the accumulated set, so loading more
  // also extends the trend rather than re-fetching the whole history.
  const {
    data: list,
    isLoading,
    isError: listError,
    refetch: refetchList,
  } = useInfiniteQuery({
    queryKey: queryKeys.labResultsInfinite({ biomarkerId, sortDir: "desc" }),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      apiGet<LabResultListResponse>(
        `/api/labs?biomarkerId=${encodeURIComponent(
          biomarkerId,
        )}&limit=${READINGS_PAGE_SIZE}&offset=${pageParam}&sortDir=desc`,
      ),
    getNextPageParam: (lastPage) => {
      const next = lastPage.meta.offset + lastPage.meta.limit;
      return next < lastPage.meta.total ? next : undefined;
    },
  });

  const readings: LabResultDto[] = useMemo(
    () => list?.pages.flatMap((p) => p.results) ?? [],
    [list],
  );
  const latest =
    readings.length > 0
      ? [...readings].sort(
          (a, b) =>
            new Date(b.takenAt).getTime() - new Date(a.takenAt).getTime(),
        )[0]
      : null;

  // v1.24 — the numbers-first stat strip + the AI assessment card mirror the
  // metric sub-pages. The strip reads a client-side `DataSummary` over the
  // numeric readings; the assessment card consumes the read-only biomarker
  // route (stale-while-revalidate, regenerated only on a new reading). The
  // strip + card both self-gate on data, so a qualitative-only or brand-new
  // marker paints neither.
  const numericReadings = useMemo(
    () => readings.filter((r) => r.value !== null),
    [readings],
  );
  // A marker is qualitative when it has readings but none of them carry a
  // numeric value — a stat strip / chart make no sense, so the page shows the
  // latest result text + assessment + the history (via the values sub-page).
  const isQualitative = readings.length > 0 && numericReadings.length === 0;
  const summary = useMemo<DataSummary | null>(
    () =>
      numericReadings.length > 0
        ? summarize(
            numericReadings.map((r) => ({
              date: new Date(r.takenAt),
              value: r.value as number,
            })),
          )
        : null,
    [numericReadings],
  );
  const mounted = useMounted();
  const { data: assessment, isLoading: assessmentLoading } =
    useInsightBiomarkerAssessment(biomarkerId, readings.length > 0);

  // v1.32.19 — a new reading for this marker changes the same-page AI
  // assessment card (`insightsBiomarkerAssessment`, mounted here) and the
  // Insights "what changed since your last panel" read (`insightsLabsChanges`).
  // Both used to stay on their pre-write text until their own stale window
  // lapsed; bust them alongside the result list so the assessment repaints as
  // soon as the reading lands.
  function invalidateAfterReadingWrite() {
    queryClient.invalidateQueries({ queryKey: queryKeys.labResults() });
    queryClient.invalidateQueries({
      queryKey: queryKeys.insightsBiomarkerAssessment(biomarkerId, locale),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.insightsLabsChanges(),
    });
  }

  function afterAdd() {
    setAddOpen(false);
    invalidateAfterReadingWrite();
  }

  // v1.30.1 H3 — "Save & add another": same invalidation as `afterAdd`,
  // minus the close. Useful here too — logging several past readings for
  // this one biomarker back-to-back without re-opening the sheet each time.
  function afterAddKeepOpen() {
    invalidateAfterReadingWrite();
  }

  function afterEditMarker() {
    setEditOpen(false);
    queryClient.invalidateQueries({
      queryKey: queryKeys.biomarkerDetail(biomarkerId),
    });
    queryClient.invalidateQueries({ queryKey: queryKeys.biomarkers() });
    // Resolved name / unit / range on every reading derives from the marker.
    queryClient.invalidateQueries({ queryKey: queryKeys.labResults() });
  }

  // v1.18.9 (#41/#3) — delete the biomarker directly from its detail page so
  // a stray marker is removable without a Settings detour. This removes every
  // reading under the marker along with it; the line here used to claim
  // `onDelete: SetNull` kept them, which stopped being true when delete became
  // a "drop this and its history" action. The confirmation dialog states it in
  // all six locales, and Hide is the reversible alternative. On success,
  // invalidate the catalog + result list and return to the labs surface.
  const deleteMarker = useMutation({
    mutationFn: () => apiDelete(`/api/biomarkers/${biomarkerId}`),
    onSuccess: () => {
      toast.success(t("labs.biomarker.deletedToast"));
      queryClient.invalidateQueries({ queryKey: queryKeys.biomarkers() });
      queryClient.invalidateQueries({ queryKey: queryKeys.labResults() });
      router.push("/labs");
    },
    onError: () => toast.error(t("labs.biomarker.deleteError")),
  });

  // v1.25.1 — the per-marker description leads the page, mirroring the metric
  // sub-pages' explainer caption. Resolve the catalog slug from the marker name
  // and fall back to the user's own `context`, then to a generic explainer so a
  // catalog-less custom marker never renders an empty description block (parity
  // with the insights metric pages, which always carry one).
  const catalogSlug = marker?.name
    ? slugByName.get(marker.name.trim().toLowerCase())
    : undefined;
  const description = catalogSlug
    ? t(`labs.catalog.desc.${catalogSlug}`)
    : marker?.context?.trim()
      ? marker.context.trim()
      : t("labs.detail.genericDescription");

  // v1.25.1 (H2-M2) — the error state keeps the heading + description and adds a
  // retry, mirroring the insights `SubPageShell` recovery affordance rather than
  // collapsing to a bare line with no context and no way back.
  if (markerError || listError) {
    return (
      <div className="space-y-6">
        <PageHeader
          title={marker?.name ?? t("labs.detail.title")}
          description={description}
        />
        <QueryErrorCard
          title={t("labs.loadError")}
          onRetry={() => {
            if (markerError) void refetchMarker();
            if (listError) void refetchList();
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={marker?.name ?? <Skeleton className="h-7 w-32" />}
        description={description}
        actions={
          <>
            {/* v1.25.3 — header control cluster, left → right:
              Delete · Edit · Show-all-values · Add. The icon controls share one
              ghost-icon treatment (the target-range editing lives inside the
              full marker editor behind the pencil, so the separate range
              control was dropped). */}
            <DeleteButton
              domain="labs"
              onConfirm={() => deleteMarker.mutate()}
              title={t("labs.biomarker.deleteConfirmTitle")}
              description={t("labs.biomarker.deleteConfirmDescription")}
              confirmLabel={t("labs.biomarker.delete")}
              triggerTitle={t("labs.biomarker.delete")}
              className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
              iconClassName="h-4 w-4"
            />
            {canManageLabs && (
              <Button
                variant="ghost"
                size="icon"
                className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
                onClick={() => setEditOpen(true)}
                disabled={!marker}
                aria-label={t("labs.biomarker.edit")}
                title={t("labs.biomarker.edit")}
              >
                <Pencil className="h-4 w-4" />
              </Button>
            )}
            {/* "Show all readings" mirrors the metric sub-pages' `<SubPageShell>`
              control. The full reading feed lives on
              `/labs/[biomarkerId]/values`; the detail page keeps the
              numbers-first spine. */}
            {readings.length > 0 ? (
              <Button
                asChild
                variant="ghost"
                size="icon"
                data-slot="lab-show-all-values"
                className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
              >
                <Link
                  href={`/labs/${biomarkerId}/values`}
                  aria-label={t("insights.subPage.showAllValues")}
                  title={t("insights.subPage.showAllValues")}
                >
                  <ListOrdered className="h-4 w-4" aria-hidden="true" />
                </Link>
              </Button>
            ) : null}
            {/* v1.36.x — entering a result is an admitted delegated write;
              renaming or removing the marker is not. */}
            {canAddLab && (
              <Button
                onClick={() => setAddOpen(true)}
                // v1.18.10 (W10) — on the narrowest phones the h1 + Edit + Delete +
                // text "Add" button crowd the row and truncate the title hard.
                // Drop the Add button to icon-only under `sm` (label kept for
                // screen readers via `aria-label`); the full text returns at `sm+`.
                className="min-h-11 min-w-11 shrink-0 sm:min-h-9 sm:min-w-0"
                aria-label={t("labs.addResult")}
              >
                <Plus className="h-4 w-4" />
                <span className="hidden sm:inline">{t("labs.addResult")}</span>
              </Button>
            )}
          </>
        }
      />

      {/* Unit + panel are meta about the marker, not its explainer, so they
          read below the header block rather than competing with it for the
          one description line every page header carries. */}
      {marker?.unit ? (
        <p className="text-muted-foreground text-sm">
          {marker.unit}
          {marker.panel ? ` · ${marker.panel}` : ""}
        </p>
      ) : null}

      {/* Bridge to the source report PDFs. There is no per-value document
          relation in the data model yet, so this links to the vault filtered
          to lab-result documents rather than the exact scan behind one value.
          Only when the documents module is enabled. */}
      {user?.modules?.inboundDocuments ? (
        <Link
          href="/documents?kind=LAB_RESULT"
          data-slot="lab-biomarker-documents-link"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex items-center gap-1.5 rounded-md text-sm transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
        >
          <FolderOpen className="size-4" aria-hidden="true" />
          {t("labs.documentsLink")}
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </Link>
      ) : null}

      {isLoading ? (
        <Card>
          <CardContent>
            <Skeleton className="h-60 w-full" />
          </CardContent>
        </Card>
      ) : readings.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={<FlaskConical className="size-6" />}
              title={t("labs.detail.emptyTitle")}
              description={t("labs.detail.emptyDescription")}
              action={
                canAddLab ? (
                  <Button onClick={() => setAddOpen(true)}>
                    {t("labs.addResult")}
                  </Button>
                ) : undefined
              }
            />
          </CardContent>
        </Card>
      ) : isQualitative ? (
        // Qualitative marker — no numeric strip / chart. Show the latest
        // result text on its own simple line, no unit, no range badge.
        <Card>
          <CardContent className="space-y-1">
            <p className="text-muted-foreground text-xs">
              {t("labs.detail.latestResult")}
            </p>
            <p className="text-2xl font-bold">{latest?.valueText ?? ""}</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Numbers-first stat strip — Min / Max / Median / Mean over the
              numeric readings, mirroring the metric sub-pages. */}
          <MetricStatStrip
            summary={summary}
            unit={marker?.unit ?? latest?.unit ?? ""}
            seriesLabel={marker?.name}
            icon={FlaskConical}
          />
          <Card>
            <CardContent>
              <LabBiomarkerChart
                readings={readings}
                unit={marker?.unit ?? latest?.unit ?? ""}
                lowerBound={marker?.lowerBound ?? null}
                upperBound={marker?.upperBound ?? null}
              />
            </CardContent>
          </Card>
        </>
      )}

      {/* AI assessment — the spine's closing block, mirroring the metric
          sub-pages (intro → stat strip → chart → assessment). The card
          self-suppresses for a qualitative-only marker (the read-only route
          returns `insufficient` without calling a provider). */}
      {readings.length > 0 ? (
        <InsightStatusCard
          title={t("insights.assessmentTitle")}
          icon={<FlaskConical className="h-5 w-5" />}
          text={assessment?.text ?? null}
          hasProvider={assessment?.hasProvider ?? false}
          updatedAt={assessment?.updatedAt ?? null}
          coachQuestion={
            marker?.name
              ? t("insights.coach.assessmentPrompt", { metric: marker.name })
              : undefined
          }
          coachAutoSend
          loading={!mounted || assessmentLoading}
          preparing={assessment?.preparing ?? false}
        />
      ) : null}

      <ResponsiveSheet
        open={addOpen}
        onOpenChange={setAddOpen}
        title={t("labs.addResult")}
        description={t("labs.addDescription")}
        footer={
          <div ref={setAddFooterEl} className="flex w-full justify-end gap-2" />
        }
      >
        <LabForm
          lockedBiomarkerId={biomarkerId}
          footerSlot={addFooterEl}
          onSuccess={afterAdd}
          onSavedKeepOpen={afterAddKeepOpen}
          onCancel={() => setAddOpen(false)}
        />
      </ResponsiveSheet>

      <ResponsiveSheet
        open={editOpen}
        onOpenChange={setEditOpen}
        title={t("labs.biomarker.editTitle")}
        description={t("labs.biomarker.defineDescription")}
        footer={
          <div
            ref={setEditFooterEl}
            className="flex w-full justify-end gap-2"
          />
        }
      >
        {marker ? (
          <BiomarkerForm
            existing={marker}
            footerSlot={editFooterEl}
            onSuccess={afterEditMarker}
            onCancel={() => setEditOpen(false)}
          />
        ) : null}
      </ResponsiveSheet>
    </div>
  );
}
