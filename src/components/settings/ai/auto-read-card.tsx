"use client";

/* ────────────────────────────────────────────────────────────────
 * Read documents automatically with AI (per-user opt-in).
 *
 * One switch. OFF by default: the vault stays local-first and every external AI
 * read of an uploaded document needs an explicit per-document action. When ON,
 * each newly uploaded document is read and indexed by the configured AI provider
 * with no per-document tap — the "upload and the AI just reads it" flow.
 *
 * Turning it ON reveals a once-shown honesty confirm (vendor-blind) before the
 * setting is written, because the trade — a subscription provider may use the
 * content to improve its models, with no data-processing agreement — must be
 * acknowledged, not buried. Turning it OFF is immediate.
 * ──────────────────────────────────────────────────────────────── */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ScanText, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Switch } from "@/components/ui/switch";
import { apiGet, apiPatch } from "@/lib/api/api-fetch";
import { useAiCapability } from "@/hooks/use-ai-capability";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

interface AutoReadPref {
  documentsAutoAiRead: boolean;
}

export function AutoReadCard() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  // With the operator's "Reading documents" switch (or all AI) off, nothing
  // would be read whatever this says, so the switch is shown disabled with
  // the reason instead of a control that silently does nothing. Turning an
  // already-on preference off stays possible.
  const documentAi = useAiCapability("documentAi");
  const operatorOff = documentAi.reason === "operator_disabled";

  // Whether the honesty confirm is currently shown (user flipped the switch ON
  // but has not yet acknowledged the trade). Off→on reveals it; the write only
  // happens on confirm.
  const [pendingEnable, setPendingEnable] = useState(false);

  const { data, isLoading } = useQuery<AutoReadPref>({
    queryKey: queryKeys.documentsAutoAiRead(),
    queryFn: () => apiGet<AutoReadPref>("/api/auth/me/documents-auto-ai-read"),
    staleTime: 60_000,
  });

  const enabled = data?.documentsAutoAiRead ?? false;

  const save = useMutation<AutoReadPref, Error, boolean>({
    mutationFn: (next: boolean) =>
      apiPatch<AutoReadPref>("/api/auth/me/documents-auto-ai-read", {
        documentsAutoAiRead: next,
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.documentsAutoAiRead(), result);
      // Flipping the toggle changes whether an ambient/per-document read
      // egresses without a per-document consent step — refresh the capability
      // probe the vault UI reads, and `/me`, whose `documentAi` capability
      // reflects the consent the toggle records.
      queryClient.invalidateQueries({
        queryKey: queryKeys.inboundDocumentAiCapability(),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.authMe() });
      setPendingEnable(false);
    },
  });

  function onSwitch(next: boolean) {
    if (next) {
      // Off → on: reveal the honesty confirm; do NOT write yet.
      if (!enabled) setPendingEnable(true);
      return;
    }
    // On → off (or cancel a pending enable): write immediately, hide confirm.
    setPendingEnable(false);
    if (enabled) save.mutate(false);
  }

  const busy = isLoading || save.isPending;
  const checked = enabled || pendingEnable;

  return (
    <SettingsCard data-slot="documents-auto-read-card">
      <SettingsCardHeader
        anchor="auto-read"
        icon={ScanText}
        title={t("settings.ai.autoRead.title")}
        description={t("settings.ai.autoRead.subLabel")}
        status={
          <Switch
            checked={checked}
            disabled={busy || (operatorOff && !enabled)}
            onCheckedChange={onSwitch}
            aria-label={t("settings.ai.autoRead.title")}
            data-testid="documents-auto-read-enable"
          />
        }
      />

      {operatorOff ? (
        <p
          data-slot="documents-auto-read-operator-off"
          className="text-muted-foreground text-xs"
        >
          {t("settings.ai.operatorOff.autoRead")}
        </p>
      ) : null}

      {pendingEnable ? (
        <div
          data-slot="documents-auto-read-confirm"
          role="note"
          className="border-border space-y-3 rounded-lg border border-dashed px-3 py-2.5"
        >
          <div className="flex items-start gap-2 text-sm">
            <ShieldAlert
              className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
              aria-hidden
            />
            <p className="min-w-0">{t("settings.ai.autoRead.honesty")}</p>
          </div>
          <SettingsCardActions>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-11 sm:min-h-9"
              disabled={save.isPending}
              onClick={() => setPendingEnable(false)}
            >
              {t("settings.ai.autoRead.cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              className="min-h-11 sm:min-h-9"
              disabled={save.isPending}
              onClick={() => save.mutate(true)}
              data-slot="documents-auto-read-confirm-cta"
            >
              {t("settings.ai.autoRead.confirm")}
            </Button>
          </SettingsCardActions>
        </div>
      ) : null}

      {save.isError ? (
        <p className="text-destructive text-xs">
          {t("settings.ai.errorGeneric")}
        </p>
      ) : null}
    </SettingsCard>
  );
}
