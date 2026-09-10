"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/lib/i18n/context";
import {
  SettingsToggle,
  useAdminSettings,
  useUpdateSettings,
  ConfiguredBadge,
} from "./_shared";
import { apiPost } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";

export function GlitchtipSection() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const { data: settings } = useAdminSettings();
  const updateSettings = useUpdateSettings();
  const [glitchtipDsnDraft, setGlitchtipDsnDraft] = useState<string | null>(
    null,
  );
  const [glitchtipEnvironmentDraft, setGlitchtipEnvironmentDraft] = useState<
    string | null
  >(null);

  const glitchtipDsnValue = glitchtipDsnDraft ?? settings?.glitchtipDsn ?? "";
  const glitchtipEnvironmentValue =
    glitchtipEnvironmentDraft ?? settings?.glitchtipEnvironment ?? "production";

  /**
   * The host the DSN addresses, and nothing else from it. An operator asking
   * "where do my errors go" is asking for a hostname; the public key in the
   * DSN answers a different question and does not belong in a status line.
   *
   * There is deliberately no default here and none anywhere else in the tree:
   * a self-hoster's crash reports must not leave their host because nobody
   * told them not to. Reporting starts when this operator types a target.
   */
  const targetHost = ((): string | null => {
    const dsn = settings?.glitchtipDsn;
    if (!dsn) return null;
    try {
      return new URL(dsn).host || null;
    } catch {
      return null;
    }
  })();

  /**
   * Three states, because "a target was typed" and "reports are arriving" are
   * different facts and only the second earns a green badge.
   *
   *   off       — the switch is off, or no target parses. Nothing is sent.
   *   unproven  — a target is set and nothing has come back from it inside the
   *               window. A wrong public key, a wrong project id and a host
   *               that stopped answering all look exactly like this, which is
   *               why it is not green.
   *   delivering — a report left successfully inside the window. The test
   *               button is the cheap way to prove it on demand.
   */
  const deliveryState = ((): "off" | "unproven" | "delivering" => {
    if (!settings?.glitchtipEnabled || !targetHost) return "off";
    // Whether the last success is recent enough is decided where the ledger
    // lives, not here: a render is not the place to read a clock.
    return settings.glitchtipReportsDelivering ? "delivering" : "unproven";
  })();

  /**
   * Why the badge is not green, in words. A reason the host recorded beats a
   * generic "unproven": an operator who typed a DSN with the wrong project id
   * gets told the target refused it rather than left to guess.
   */
  const unprovenReason = ((): string | null => {
    if (deliveryState !== "unproven") return null;
    if (settings?.glitchtipLastFailureReason) {
      return t("admin.glitchtipDeliveryFailed", {
        reason: settings.glitchtipLastFailureReason,
      });
    }
    if (settings?.glitchtipEverDelivered) {
      return t("admin.glitchtipDeliveryStale", {
        hours: settings.glitchtipDeliveryWindowHours,
      });
    }
    return t("admin.glitchtipDeliveryUnproven");
  })();

  const testGlitchtip = useMutation({
    mutationFn: async () => {
      const data = await apiPost<{ message?: string } | undefined>(
        "/api/admin/monitoring/glitchtip-test",
      );
      return data?.message ?? t("admin.monitoringTestSuccess");
    },
    onSuccess: (message) => {
      toast.success(message);
      // The send just recorded an outcome. Re-read it, so the badge answers
      // the question the operator pressed the button to ask.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.adminSettings(),
      });
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : t("admin.monitoringTestFailed"),
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.adminSettings(),
      });
    },
  });

  function saveGlitchtipSettings() {
    updateSettings.mutate(
      {
        glitchtipDsn: glitchtipDsnValue,
        glitchtipEnvironment: glitchtipEnvironmentValue,
      },
      {
        onSuccess: () => {
          setGlitchtipDsnDraft(null);
          setGlitchtipEnvironmentDraft(null);
        },
      },
    );
  }

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={AlertTriangle}
        title={t("admin.glitchtipTitle")}
        description={t("admin.glitchtipDescription")}
        status={
          deliveryState === "delivering" ? (
            <ConfiguredBadge />
          ) : deliveryState === "unproven" ? (
            <Badge className="border-warning/30 bg-warning/15 text-warning">
              {t("admin.glitchtipUnproven")}
            </Badge>
          ) : null
        }
      />

      <div className="space-y-3">
        <SettingsToggle
          label={t("admin.glitchtipEnabled")}
          icon={AlertTriangle}
          checked={settings?.glitchtipEnabled ?? false}
          onCheckedChange={(checked) =>
            updateSettings.mutate({ glitchtipEnabled: checked })
          }
          disabled={updateSettings.isPending}
        />
        {/* Only once the settings are in hand: a line that says "nothing is
            sent" while the answer is still loading is a claim, not a
            placeholder. */}
        {settings ? (
          <div className="space-y-1">
            <p className="text-sm" data-slot="glitchtip-target">
              {deliveryState !== "off" && targetHost
                ? t("admin.glitchtipTargetOn", { host: targetHost })
                : settings.glitchtipEnabled
                  ? t("admin.glitchtipTargetNoTarget")
                  : t("admin.glitchtipTargetOff")}
            </p>
            {unprovenReason ? (
              <p
                className="text-muted-foreground text-xs"
                data-slot="glitchtip-delivery"
              >
                {unprovenReason}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="admin-glitchtip-dsn" className="text-xs">
              {t("admin.glitchtipDsn")}
            </Label>
            <Input
              id="admin-glitchtip-dsn"
              name="admin-glitchtip-dsn"
              value={glitchtipDsnValue}
              onChange={(event) => setGlitchtipDsnDraft(event.target.value)}
              placeholder={t("admin.glitchtipDsnPlaceholder")}
              autoComplete="new-password"
              spellCheck={false}
              data-lpignore="true"
              data-1p-ignore="true"
              data-bwignore="true"
              disabled={updateSettings.isPending}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="admin-glitchtip-environment" className="text-xs">
              {t("admin.glitchtipEnvironment")}
            </Label>
            <Input
              id="admin-glitchtip-environment"
              name="admin-glitchtip-environment"
              value={glitchtipEnvironmentValue}
              onChange={(event) =>
                setGlitchtipEnvironmentDraft(event.target.value)
              }
              placeholder={t("admin.glitchtipEnvironmentPlaceholder")}
              autoComplete="new-password"
              spellCheck={false}
              data-lpignore="true"
              data-1p-ignore="true"
              data-bwignore="true"
              disabled={updateSettings.isPending}
            />
          </div>
        </div>
      </div>

      <SettingsCardActions>
        <Button
          size="sm"
          variant="outline"
          onClick={() => testGlitchtip.mutate()}
          disabled={testGlitchtip.isPending || updateSettings.isPending}
        >
          {testGlitchtip.isPending && (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          )}
          {t("common.test")}
        </Button>
        <Button
          size="sm"
          onClick={saveGlitchtipSettings}
          disabled={updateSettings.isPending}
        >
          {updateSettings.isPending && (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          )}
          {t("common.save")}
        </Button>
      </SettingsCardActions>
    </SettingsCard>
  );
}
