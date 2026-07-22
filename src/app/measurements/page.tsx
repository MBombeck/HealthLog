"use client";

import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import {
  MeasurementForm,
  resolveAddToken,
} from "@/components/measurements/measurement-form";
import { MeasurementList } from "@/components/measurements/measurement-list";
import { CustomMetricList } from "@/components/custom-metrics/custom-metric-list";
import { MEASUREMENT_TYPE_LABEL_KEYS } from "@/components/measurements/measurement-list-meta";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { PageAuthGate } from "@/components/ui/page-auth-gate";
import { PullToRefreshIndicator } from "@/components/ui/pull-to-refresh-indicator";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Plus } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "@/lib/i18n/context";
import { SUB_PAGE_SLUGS } from "@/lib/insights/sub-page-metric";

const INSIGHT_METRIC_RETURN_PATHS: Readonly<Record<string, true>> =
  Object.fromEntries(
    SUB_PAGE_SLUGS.map((slug) => [`/insights/${slug}`, true] as const),
  );

export function resolveMeasurementReturnTo(
  returnTo: string | null | undefined,
): string | null {
  return returnTo && INSIGHT_METRIC_RETURN_PATHS[returnTo] ? returnTo : null;
}

export default function MeasurementsPage() {
  const { isAuthenticated, isLoading } = useAuth();
  const mounted = useMounted();
  const router = useRouter();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const { t } = useTranslations();

  // v1.4.27 MB6 — read the `?add=<TYPE>` query param during render so
  // the dialog opens on the first paint (no flash of the page behind
  // it). The first-load param is consumed in the `useState` lazy
  // initializers: they run identically on the server and the hydration
  // render (pure token resolution, no router call), so SSR — which sees
  // real search params now that the root layout renders every route
  // dynamically — stays side-effect free. Calling `router.replace`
  // during a server render throws (`location is not defined`); the
  // query-strip lives in the effect below instead. The render-driven
  // block then only handles LATER client-side navigations back to
  // `?add=` (e.g. the insights empty-state CTAs), following the
  // state-from-prop pattern in `account-section.tsx` — the lint rule
  // `react-hooks/set-state-in-effect` rejects setState from inside an
  // effect, so that path stays render-driven.
  const addParam = searchParams.get("add");
  const initialAdd = addParam ? resolveAddToken(addParam) : null;
  const returnToParam = searchParams.get("returnTo");
  const initialReturnTo = resolveMeasurementReturnTo(returnToParam);
  const addRequestParam = addParam
    ? `${addParam}\u0000${returnToParam ?? ""}`
    : null;
  // v1.18.7 (Wave E) — a `?type=<MEASUREMENT_TYPE>` deep link (e.g. the
  // Vorsorge card's "Show measurements") seeds the list's type filter on
  // first paint. Captured once via a lazy initializer so the value is
  // stable even after the effect below strips the query string; an unknown
  // token is dropped (validated against the canonical type-label map), so a
  // stale link never traps the user on a broken filter.
  const typeParam = searchParams.get("type");
  const [initialType] = useState<string | undefined>(() =>
    typeParam && typeParam in MEASUREMENT_TYPE_LABEL_KEYS
      ? typeParam
      : undefined,
  );
  const [dialogOpen, setDialogOpen] = useState(() => initialAdd != null);
  const [defaultType, setDefaultType] = useState<string | undefined>(
    () => initialAdd ?? undefined,
  );
  const [returnTo, setReturnTo] = useState<string | null>(
    () => initialReturnTo,
  );
  const [consumedAddRequest, setConsumedAddRequest] = useState<string | null>(
    () => addRequestParam,
  );
  // v1.4.27 R4 RC2 — DOM handle the form portals its action row into so
  // the Sheet branch can sticky-pin Save / Cancel.
  const [footerEl, setFooterEl] = useState<HTMLDivElement | null>(null);

  // v1.16.4 — PWA pull-to-refresh: a top-anchored touch pull refetches
  // whatever this page currently has mounted (`type: "active"` scopes the
  // invalidation to visible queries). Suspended while the add-sheet is
  // open so a drag inside the form can't arm the gesture.
  const refreshVisible = useCallback(
    () => queryClient.invalidateQueries({ type: "active" }),
    [queryClient],
  );
  const pull = usePullToRefresh({
    onRefresh: refreshVisible,
    disabled: dialogOpen,
  });

  // Later client-side navigation landed on `?add=` again. Once the effect
  // below strips the request, clear the consumed key so repeating the same
  // type later is still treated as a new one-shot capture.
  if (!addRequestParam && consumedAddRequest !== null) {
    setConsumedAddRequest(null);
  } else if (addRequestParam && addRequestParam !== consumedAddRequest) {
    setConsumedAddRequest(addRequestParam);
    const resolved = resolveAddToken(addParam);
    if (resolved) {
      setDefaultType(resolved);
      setDialogOpen(true);
      setReturnTo(resolveMeasurementReturnTo(returnToParam));
    }
  }

  // Drop the query string so the back-button leaves the user on
  // `/measurements` rather than re-opening the dialog (or re-seeding the
  // type filter). The type filter is already seeded into the list's own
  // state via `initialType`, so stripping the param doesn't lose it.
  // Effect-driven (client-only) because `router.replace` is not callable
  // during SSR.
  useEffect(() => {
    if (addParam || typeParam || returnToParam) router.replace("/measurements");
  }, [addParam, typeParam, returnToParam, router]);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push("/auth/login");
    }
  }, [isLoading, isAuthenticated, router]);

  // v1.16.4 — `!mounted` keeps the hydration render identical to the
  // SSR HTML when this boundary hydrates after `/api/auth/me` settled
  // (React #418 family); see `useMounted`.
  if (!mounted || isLoading) {
    return <PageAuthGate label={t("common.loading")} />;
  }

  return (
    <div className="space-y-6">
      <PullToRefreshIndicator {...pull} />
      <PageHeader
        title={
          <span data-tour-id="measurements-hero">
            {t("measurements.title")}
          </span>
        }
        description={t("measurements.subtitle")}
        actions={
          <Button
            className="min-h-11 sm:min-h-9"
            onClick={() => {
              setReturnTo(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            {t("measurements.addMeasurement")}
          </Button>
        }
      />

      <ResponsiveSheet
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setDefaultType(undefined);
            setReturnTo(null);
          }
        }}
        title={t("measurements.addMeasurement")}
        footer={<div ref={setFooterEl} className="flex w-full" />}
      >
        <MeasurementForm
          defaultType={defaultType}
          onSuccess={() => {
            const destination = returnTo;
            setDialogOpen(false);
            setDefaultType(undefined);
            setReturnTo(null);
            if (destination) router.replace(destination);
          }}
          onCancel={() => {
            setDialogOpen(false);
            setDefaultType(undefined);
            setReturnTo(null);
          }}
          footerSlot={footerEl}
        />
      </ResponsiveSheet>

      <MeasurementList
        onAddFirst={() => {
          setReturnTo(null);
          setDialogOpen(true);
        }}
        initialType={initialType}
      />

      <CustomMetricList />
    </div>
  );
}
