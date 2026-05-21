"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BookOpenCheck, Loader2, Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ResearchModeAcknowledgmentDialog } from "@/components/medications/ResearchModeAcknowledgmentDialog";
import { formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  type ResearchModeStatus,
  researchModeGateState,
} from "@/lib/medications/research-mode-types";

/**
 * Settings → Advanced.
 *
 * v1.4.16 phase B7: every export path (CSV, JSON, doctor-report PDF)
 * moved out into the dedicated `<ExportSection>` under `/settings/export`.
 * What stays here is the irreversible danger-zone — the "wipe all my
 * data" surface that should never live next to a single-click export
 * button.
 *
 * v1.4.25 W19c-Frontend adds the Research Mode toggle on this page.
 * Research Mode and the data-reset are both opt-in / version-gated
 * controls; they share a semantic shelf even though they touch
 * different parts of the user record. Toggle ON opens the
 * acknowledgment dialog (the user reads + confirms before the server
 * stamps the version). Toggle OFF fires DELETE directly. A separate
 * amber banner above the toggle catches the version-mismatch case
 * (server bumped the disclaimer while the user was still
 * acknowledged) and surfaces a Re-acknowledge CTA that re-opens the
 * dialog.
 */
export function AdvancedSection() {
  const { t } = useTranslations();

  return (
    <section
      aria-labelledby="settings-section-advanced-title"
      className="space-y-6"
    >
      <header className="space-y-1">
        <h1
          id="settings-section-advanced-title"
          className="text-2xl font-semibold tracking-tight"
        >
          {t("settings.sections.advanced.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.advanced.description")}
        </p>
      </header>

      <ResearchModeCard />
      <DataResetCard />
    </section>
  );
}

/**
 * v1.4.25 W21 Fix-N (simp-H3) — pull the nested ternary that decided
 * the toggle's caption out of the JSX. The four-way ladder (loading /
 * enabled-open / enabled-stale / disabled) is dense to read inline,
 * and the surface stays open to a fifth state ("never queried") when
 * we wire the offline shell in v1.4.26.
 */
function researchModeStatusLabel(
  status: ResearchModeStatus | null | undefined,
  isLoading: boolean,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (isLoading) return t("common.loading");
  const gate = researchModeGateState(status);
  if (gate === "off") return t("settings.researchMode.disabledStatus");
  if (gate === "stale") return t("settings.researchMode.enabledStaleStatus");
  return t("settings.researchMode.acknowledgedOn", {
    date: status?.acknowledgedAt
      ? formatDateTime(status.acknowledgedAt)
      : "—",
  });
}

function ResearchModeCard() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { data: status, isLoading } = useQuery<ResearchModeStatus | null>({
    queryKey: queryKeys.researchMode(),
    queryFn: async () => {
      const res = await fetch("/api/auth/me/research-mode");
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as ResearchModeStatus;
    },
    staleTime: 60 * 1000,
  });

  const gateState = researchModeGateState(status);
  const showRePrompt = gateState === "stale";
  // The Switch's `checked` mirrors the server flag exactly — even when
  // the version is stale we keep the toggle "on" so the user sees that
  // their previous choice is preserved; the banner above the toggle
  // explains why the chart isn't painting.
  const switchChecked = !!status?.enabled;

  async function handleToggle(next: boolean) {
    if (toggleBusy) return;
    setErrorMessage(null);
    if (next) {
      // Toggle ON → open the acknowledgment dialog. The dialog owns
      // the POST; on success it invalidates the `research-mode` query
      // and the toggle reflects the new state.
      setDialogOpen(true);
      return;
    }
    // Toggle OFF → fire DELETE directly.
    setToggleBusy(true);
    try {
      const res = await fetch("/api/auth/me/research-mode", {
        method: "DELETE",
      });
      if (!res.ok) {
        setErrorMessage(t("settings.researchMode.disableError"));
        return;
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.researchMode() });
    } catch {
      setErrorMessage(t("settings.researchMode.disableError"));
    } finally {
      setToggleBusy(false);
    }
  }

  return (
    <div
      className="bg-card border-border rounded-xl border p-6"
      data-slot="settings-research-mode-card"
    >
      <div className="flex items-center gap-2">
        <BookOpenCheck className="text-dracula-purple h-5 w-5" />
        <h2 className="text-lg font-semibold">
          {t("settings.researchMode.sectionTitle")}
        </h2>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("settings.researchMode.subtitle")}
      </p>

      {showRePrompt && (
        <div
          role="alert"
          data-slot="settings-research-mode-reprompt"
          className="border-warning/40 bg-warning/10 mt-4 rounded-md border-l-4 px-3 py-2 text-sm"
        >
          <p className="text-foreground font-medium">
            {t("settings.researchMode.rePromptTitle")}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            {t("settings.researchMode.rePromptBody")}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => setDialogOpen(true)}
            data-slot="settings-research-mode-reprompt-cta"
          >
            {t("settings.researchMode.rePromptCta")}
          </Button>
        </div>
      )}

      <div className="mt-4 flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">
            {t("settings.researchMode.toggleLabel")}
          </p>
          <p
            className="text-muted-foreground text-xs"
            data-slot="settings-research-mode-status"
          >
            {researchModeStatusLabel(status, isLoading, t)}
          </p>
        </div>
        <Switch
          checked={switchChecked}
          disabled={isLoading || toggleBusy}
          onCheckedChange={(next) => {
            void handleToggle(next);
          }}
          aria-label={t("settings.researchMode.toggleLabel")}
          data-slot="settings-research-mode-toggle"
        />
      </div>

      {errorMessage && (
        <p
          role="alert"
          className="text-destructive mt-3 text-sm"
          data-slot="settings-research-mode-error"
        >
          {errorMessage}
        </p>
      )}

      <ResearchModeAcknowledgmentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        currentDisclaimerVersion={status?.currentDisclaimerVersion ?? null}
      />
    </div>
  );
}

function DataResetCard() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

  async function handleDeleteAllData() {
    setDeleting(true);
    setMsg(null);
    setMsgType(null);
    try {
      const res = await fetch("/api/settings/data", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMsg(json.error || t("settings.dangerZoneDeleteFailed"));
        setMsgType("error");
        return;
      }

      await queryClient.invalidateQueries();
      setMsg(t("settings.dangerZoneSuccess"));
      setMsgType("success");
    } catch {
      setMsg(t("settings.dangerZoneDeleteFailed"));
      setMsgType("error");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="bg-card border-border rounded-xl border p-6">
      <div className="flex items-center gap-2">
        <AlertTriangle className="text-destructive h-5 w-5" />
        <h2 className="text-destructive text-lg font-semibold">
          {t("settings.dangerZone")}
        </h2>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("settings.dangerZoneDescription")}
      </p>

      <div className="mt-4">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" size="sm" disabled={deleting}>
              {deleting ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              ) : (
                <Trash2 className="mr-1 h-3.5 w-3.5" />
              )}
              {t("settings.dangerZone")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("settings.dangerZoneConfirm")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("settings.dangerZoneConfirmDescription")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={handleDeleteAllData}
              >
                {t("settings.finalDelete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {msg && (
        <p
          role="alert"
          className={`mt-3 text-sm ${msgType === "success" ? "text-dracula-green" : "text-destructive"}`}
        >
          {msg}
        </p>
      )}
    </div>
  );
}
