"use client";

/**
 * v1.7.0 — full intake-history view.
 *
 * Reached directly from the detail-page header's History button. This
 * surface is intake-history ONLY: the estimated drug-level curve, the
 * side-effect logbook, the schedule ("Rhythmus") editor and the
 * titration ladder no longer dominate here. The only editable units
 * are individual intakes (edit / delete / bulk-delete via the shared
 * `<IntakeHistoryEditable>`); CSV import is present but de-emphasised
 * as a ghost action in the header.
 *
 * Sort defaults to `scheduledFor desc` so the order reads
 * today → yesterday → … and skipped rows (`takenAt: null`) never float
 * to the top (O-1).
 *
 * The estimated active-ingredient curve stays available as a
 * default-CLOSED disclosure at the bottom for GLP-1 medications (O-2);
 * it is genuine history context but opt-in, not the default read.
 */

import { useEffect, useState, use } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Upload } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { DrugLevelChart } from "@/components/medications/DrugLevelChart";
import { TitrationSection } from "@/components/medications/TitrationSection";
import { IntakeHistoryEditable } from "@/components/medications/intake-history-editable";
import { IntakeImportDialog } from "@/components/medications/intake-import-dialog";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

export default function IntakeHistoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const { t } = useTranslations();

  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push("/auth/login");
    }
  }, [authLoading, isAuthenticated, router]);

  const { data: medication, isLoading: medLoading } = useQuery({
    queryKey: queryKeys.medicationDetail(id),
    queryFn: async () => {
      const res = await fetch(`/api/medications/${id}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const json = await res.json();
      return json.data as {
        id: string;
        name: string;
        dose: string;
        treatmentClass?: string;
        notificationsEnabled?: boolean;
      };
    },
    enabled: isAuthenticated,
  });

  if (authLoading || medLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  const isGlp1 = medication?.treatmentClass === "GLP1";

  return (
    <div className="space-y-6">
      {/* Back to the medication detail page — history is a drill-down
          OF the medication, not a sibling of the list. */}
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground -ml-2 gap-1"
        asChild
      >
        <Link href={`/medications/${id}`}>
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
          {t("medications.detail.history.back")}
        </Link>
      </Button>

      {medication && (
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">
              {medication.name}
            </h1>
            <p className="text-muted-foreground text-sm">{medication.dose}</p>
            <p className="text-muted-foreground text-xs">
              {t("medications.detail.history.subtitle")}
            </p>
          </div>
          {/* De-emphasised import — ghost / muted, not a prominent CTA. */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setImportOpen(true)}
            className="text-muted-foreground min-h-11 sm:min-h-9"
            data-slot="history-import-trigger"
          >
            <Upload aria-hidden="true" className="h-4 w-4" />
            {t("medications.detail.intake.importButton")}
          </Button>
        </div>
      )}

      {medication && (
        <IntakeHistoryEditable
          medicationId={id}
          pageSize={25}
          defaultSortBy="scheduledFor"
        />
      )}

      {/* O-2 — estimated active-ingredient curve + titration ladder as a
          default-CLOSED disclosure for GLP-1 medications. Genuine
          context, but opt-in so the intake table stays the dominant
          surface. The chart itself gates further on Research Mode. */}
      {medication && isGlp1 && (
        <details
          className="border-border/60 rounded-md border"
          data-slot="history-drug-level-disclosure"
        >
          <summary className="text-foreground flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium select-none sm:min-h-9">
            {t("medications.detail.history.drugLevelDisclosure")}
          </summary>
          <div className="border-border/60 space-y-6 border-t px-3 py-3">
            <DrugLevelChart
              medication={{
                id: medication.id,
                name: medication.name,
                dose: medication.dose,
              }}
            />
            <TitrationSection medicationId={id} />
          </div>
        </details>
      )}

      {importOpen && (
        <IntakeImportDialog
          medicationId={id}
          onClose={() => setImportOpen(false)}
        />
      )}
    </div>
  );
}
