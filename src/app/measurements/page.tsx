"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { MeasurementForm } from "@/components/measurements/measurement-form";
import { MeasurementList } from "@/components/measurements/measurement-list";
import { Button } from "@/components/ui/button";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Plus, Loader2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "@/lib/i18n/context";

// v1.4.27 MB6 — the insights empty-state CTAs link here with a
// `?add=<TYPE>` query param to auto-open the add-measurement dialog
// with the right default type. Keep the allow-list aligned with
// MEASUREMENT_TYPES inside `measurement-form.tsx`; an unknown value
// is dropped silently so a stale link can never trap the user on a
// broken form.
const ALLOWED_ADD_TYPES = new Set([
  "BLOOD_PRESSURE",
  "WEIGHT",
  "PULSE",
  "BMI",
  "GLUCOSE",
  "TEMPERATURE",
  "BODY_FAT",
  "HEART_RATE",
]);

export default function MeasurementsPage() {
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useTranslations();

  // v1.4.27 MB6 — read the `?add=<TYPE>` query param during render so
  // the dialog opens on the first paint (no flash of the page behind
  // it). The state-from-prop pattern follows `account-section.tsx`:
  // store the "addToken we acted on" sentinel and let render kick off
  // the open + replace transition once per param value. The lint rule
  // `react-hooks/set-state-in-effect` rejects setState from inside an
  // effect, so the open-on-param work is render-driven instead.
  const addParam = searchParams.get("add");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [defaultType, setDefaultType] = useState<string | undefined>(
    undefined,
  );
  const [consumedAddParam, setConsumedAddParam] = useState<string | null>(null);
  // v1.4.27 R4 RC2 — DOM handle the form portals its action row into so
  // the Sheet branch can sticky-pin Save / Cancel.
  const [footerEl, setFooterEl] = useState<HTMLDivElement | null>(null);

  if (addParam && addParam !== consumedAddParam) {
    setConsumedAddParam(addParam);
    if (ALLOWED_ADD_TYPES.has(addParam)) {
      setDefaultType(addParam);
      setDialogOpen(true);
    }
    // Drop the query string so the back-button leaves the user on
    // `/measurements` rather than re-opening the dialog.
    router.replace("/measurements");
  }

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push("/auth/login");
    }
  }, [isLoading, isAuthenticated, router]);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {t("measurements.title")}
          </h1>
          <p className="text-muted-foreground hidden text-sm sm:block">
            {t("measurements.subtitle")}
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          {t("measurements.addMeasurement")}
        </Button>
      </div>

      <ResponsiveSheet
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setDefaultType(undefined);
        }}
        title={t("measurements.addMeasurement")}
        footer={<div ref={setFooterEl} className="flex w-full" />}
      >
        <MeasurementForm
          defaultType={defaultType}
          onSuccess={() => {
            setDialogOpen(false);
            setDefaultType(undefined);
          }}
          onCancel={() => {
            setDialogOpen(false);
            setDefaultType(undefined);
          }}
          footerSlot={footerEl}
        />
      </ResponsiveSheet>

      <MeasurementList onAddFirst={() => setDialogOpen(true)} />
    </div>
  );
}
