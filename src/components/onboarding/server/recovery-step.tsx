"use client";

import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";

import {
  DISASTER_RECOVERY_GUIDE_URL,
  keyLabel,
} from "@/components/admin/recovery-kit-card";
import { useRecoveryKit } from "@/components/admin/use-recovery-kit";
import { StepActions } from "@/components/onboarding/step-actions";
import { StepHeading } from "@/components/onboarding/step-heading";
import { Checkbox } from "@/components/ui/checkbox";
import { InlineAction } from "@/components/ui/inline-action";
import { Label } from "@/components/ui/label";
import { apiPost } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import { useServerStep } from "./use-server-step";

/**
 * Save the recovery kit (1.50): every key a reinstall needs, with its id and
 * fingerprint (never the key), and one confirmation that a copy of each is
 * kept elsewhere. The confirmation goes through the kit's own route with the
 * keys exactly as shown, as the Admin card does.
 *
 * "Later" sets the kit aside for seven days: the dashboard banner waits that
 * long, and comes back at once when a key changes.
 */
export function RecoveryStep() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const kit = useRecoveryKit();
  const step = useServerStep("recovery");
  const confirmId = useId();
  const [kept, setKept] = useState(false);
  const [working, setWorking] = useState(false);

  async function finish(confirm: boolean) {
    if (working) return;
    setWorking(true);
    try {
      if (confirm && kit.data) {
        await apiPost("/api/admin/recovery-kit/confirm", {
          entries: kit.data.keys.map(({ kind, id, fingerprint }) => ({
            kind,
            id,
            fingerprint,
          })),
        });
        await queryClient.invalidateQueries({
          queryKey: queryKeys.adminRecoveryKit(),
        });
      }
      await step.record(confirm ? "done" : "skipped");
    } catch (err) {
      setWorking(false);
      step.fail(err);
    }
  }

  return (
    <section
      aria-labelledby="server-setup-recovery-title"
      className="flex flex-1 flex-col"
      data-slot="server-setup-step"
      data-step="recovery"
    >
      <StepHeading
        id="server-setup-recovery-title"
        title={t("setup.server.recovery.title")}
        description={t("setup.server.recovery.body")}
        tone="foreground"
      />
      <ul
        className="border-border bg-card divide-border divide-y rounded-lg border"
        data-testid="recovery-kit-keys"
      >
        {(kit.data?.keys ?? []).map((k) => (
          <li
            key={`${k.kind}:${k.id}`}
            className="flex items-center gap-3 px-4 py-3"
            data-confirmed={k.confirmed ? "true" : "false"}
          >
            <KeyRound
              aria-hidden="true"
              className="text-foreground size-4 shrink-0"
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{keyLabel(t, k)}</p>
              <p className="text-muted-foreground font-mono text-xs break-all">
                {k.fingerprint ?? t("admin.recoveryKit.noFingerprint")}
              </p>
            </div>
            <span className="text-muted-foreground shrink-0 text-xs">
              {t(
                k.confirmed
                  ? "admin.recoveryKit.status.confirmed"
                  : k.problem === "not_configured"
                    ? "admin.recoveryKit.status.notConfigured"
                    : k.problem === "unreadable"
                      ? "admin.recoveryKit.status.unreadable"
                      : "admin.recoveryKit.status.new",
              )}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-sm">
        <InlineAction asChild size="sm">
          <a
            href={DISASTER_RECOVERY_GUIDE_URL}
            target="_blank"
            rel="noreferrer"
          >
            {t("setup.server.recovery.guide")}
          </a>
        </InlineAction>
      </p>
      <div className="mt-6 flex items-start gap-3">
        <Checkbox
          id={confirmId}
          checked={kept}
          onCheckedChange={(next) => setKept(next === true)}
          className="mt-0.5"
          data-slot="server-setup-recovery-kept"
        />
        <Label
          htmlFor={confirmId}
          className="text-foreground text-sm leading-relaxed font-normal"
        >
          {t("setup.server.recovery.kept")}
        </Label>
      </div>
      <StepActions
        secondary={{
          label: t("setup.later"),
          onClick: () => void finish(false),
        }}
        primary={{
          label: t("setup.done"),
          onClick: () => void finish(true),
          disabled: !kept || !kit.data,
        }}
        pending={working}
      />
    </section>
  );
}
