"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  FolderOpen,
  Loader2,
  Pencil,
  Plus,
  ScanLine,
  Wrench,
} from "lucide-react";

import { LabForm } from "@/components/labs/lab-form";
import { LabList } from "@/components/labs/lab-list";
import { OcrReviewDialog } from "@/components/labs/ocr-review-dialog";
import {
  shouldProbeOcrCapability,
  useOcrCapability,
} from "@/components/labs/use-ocr-extract";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PageHeader } from "@/components/ui/page-header";
import { PullToRefreshIndicator } from "@/components/ui/pull-to-refresh-indicator";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

export default function LabsPage() {
  const { user, isAuthenticated, isLoading } = useAuth();
  // v1.36.x — entering a lab result by hand is an admitted delegated write.
  // Scanning a report is not: it files a document and commits through the OCR
  // route, and neither is delegated. So a WRITE delegate keeps the manual add
  // and loses the choice menu around it.
  const { canWriteDomain, inSharedRecord } = useRecordCapabilities();
  const canAddLab = canWriteDomain("labs");
  const mounted = useMounted();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { t } = useTranslations();
  const [dialogOpen, setDialogOpen] = useState(false);
  // Sticky-footer slot element for the add-result sheet (filled by the
  // ResponsiveSheet `footer` ref so the form portals its action row there).
  const [addFooterEl, setAddFooterEl] = useState<HTMLDivElement | null>(null);
  // v1.18.9 — Lab-OCR "Scan a report" dialog. The scan affordance only shows
  // when the user's configured AI provider can read images (capability probe).
  const [scanOpen, setScanOpen] = useState(false);

  // Gated on the resolved `modules.labs` flag from `GET /api/auth/me` (the
  // per-user toggle AND the operator server-wide kill-switch). Default-on: an
  // absent key reads as enabled, so a direct URL hit only bounces on an
  // explicit `false`. Every `/api/labs/*` route also enforces the gate
  // server-side, so this is a UX redirect, not the security boundary.
  const enabled = inSharedRecord || user?.modules?.labs !== false;
  const ocrCapability = useOcrCapability(
    shouldProbeOcrCapability({
      isAuthenticated,
      isLoading,
      labsEnabled: enabled,
      mounted,
      ownRecord: !inSharedRecord,
    }),
  );

  const refreshVisible = useCallback(
    () => queryClient.invalidateQueries({ type: "active" }),
    [queryClient],
  );
  const pull = usePullToRefresh({
    onRefresh: refreshVisible,
    disabled: dialogOpen,
  });

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      router.push("/auth/login");
    } else if (!enabled) {
      router.push("/");
    }
  }, [isLoading, isAuthenticated, enabled, router]);

  if (!mounted || isLoading || (isAuthenticated && !enabled)) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PullToRefreshIndicator {...pull} />
      <PageHeader
        title={<span data-tour-id="labs-hero">{t("labs.title")}</span>}
        description={t("labs.subtitle")}
        actions={
          <>
            {/* v1.18.6 (MOD-01) — the wrench is the module's customize entry
                point, left of the primary Add and linking to the Labs settings
                page (view, sort order, biomarker CRUD + reorder). Mirrors the
                medication page header's wrench glyph + slot + 44px tap floor. */}
            {!inSharedRecord && (
              <Button
                asChild
                variant="ghost"
                size="icon"
                className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
              >
                <Link
                  href="/settings/layout/labs"
                  aria-label={t("labs.customize")}
                  title={t("labs.customize")}
                >
                  <Wrench className="h-4 w-4" aria-hidden="true" />
                </Link>
              </Button>
            )}
            {/* v1.18.10 — the "Add" action is a CHOICE when scanning is
                available: scan a document (OCR) or add a value by hand. The scan
                option only appears when the capability probe reports a usable
                mode (vision, or local OCR opted-in for text-only providers), so
                the surface stays simple for everyone else. When scanning is
                unavailable, Add opens the manual form directly. */}
            {ocrCapability.data?.available && !inSharedRecord ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button className="min-h-11 sm:min-h-9">
                    <Plus className="h-4 w-4" />
                    {t("common.add")}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setScanOpen(true)}>
                    <ScanLine className="h-4 w-4" aria-hidden="true" />
                    {t("labs.ocr.addScan")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setDialogOpen(true)}>
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                    {t("labs.ocr.addManual")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : canAddLab ? (
              <Button
                onClick={() => setDialogOpen(true)}
                className="min-h-11 sm:min-h-9"
              >
                <Plus className="h-4 w-4" />
                {t("common.add")}
              </Button>
            ) : null}
          </>
        }
      />

      {/* Entry point into the document vault, pre-filtered to lab-result
          documents (the original report PDFs behind these values). Only
          rendered when the documents module is enabled for this account. */}
      {user?.modules?.inboundDocuments ? (
        <Link
          href="/documents?kind=LAB_RESULT"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex items-center gap-1.5 rounded-md text-sm transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
        >
          <FolderOpen className="size-4" aria-hidden />
          {t("labs.documentsLink")}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      ) : null}

      <ResponsiveSheet
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={t("labs.addResult")}
        description={t("labs.addDescription")}
        footer={
          <div ref={setAddFooterEl} className="flex w-full justify-end gap-2" />
        }
      >
        <LabForm
          footerSlot={addFooterEl}
          onSuccess={() => {
            setDialogOpen(false);
            queryClient.invalidateQueries({
              queryKey: queryKeys.labResults(),
            });
          }}
          // v1.30.1 H3 — "Save & add another" keeps the sheet open; the
          // form clears the reading itself, this callback just refreshes
          // the list underneath so the just-saved row is there once the
          // user is done and closes the sheet.
          onSavedKeepOpen={() => {
            queryClient.invalidateQueries({
              queryKey: queryKeys.labResults(),
            });
          }}
          onCancel={() => setDialogOpen(false)}
        />
      </ResponsiveSheet>

      {ocrCapability.data?.available && ocrCapability.data.mode ? (
        <OcrReviewDialog
          open={scanOpen}
          onOpenChange={setScanOpen}
          mode={ocrCapability.data.mode}
          pdfSupported={ocrCapability.data.pdfSupported}
          onCommitted={() => {
            queryClient.invalidateQueries({
              queryKey: queryKeys.labResults(),
            });
            queryClient.invalidateQueries({
              queryKey: queryKeys.biomarkers(),
            });
          }}
        />
      ) : null}

      <LabList onAddFirst={() => setDialogOpen(true)} />
    </div>
  );
}
