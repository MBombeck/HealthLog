"use client";

/**
 * v1.22 (B6) — Settings → AI "Your context: reminders" panel.
 *
 * The user-facing ledger for the durable "remind me about X" memory the Coach
 * captures inline (the `---REMEMBER---` sentinel) and the sweep resurfaces. The
 * due / surfaced reminders are highlighted at the top (the in-app surface of the
 * sweep output); the rest are listed with view + lifecycle controls so the user
 * stays in control of their stored memory:
 *
 *   GET    /api/coach/reminders                 → { data: { reminders: [...] } }
 *   PATCH  /api/coach/reminders/{id} {status}   → confirm / done / dismiss
 *   DELETE /api/coach/reminders/{id}            → { data: { deleted } }
 *
 * Reads unwrap `(await res.json()).data`; every key routes through
 * `queryKeys.coachReminders()` so a mutation invalidates the list.
 *
 * v1.39 — never gated on the Coach. A reminder is the person's own record, like
 * the stored facts and conversations: the list and delete routes ask no Coach
 * gate, so the card stays readable and every reminder stays deletable while the
 * Coach is unavailable for any reason. Keeping, resolving or dismissing one is
 * Coach use (the PATCH route refuses it then), so those controls are not
 * offered in that state. Settings → Coach always mounts this card; Settings → AI
 * mounts it through `<StoredCoachMemory>` with `hideWhenEmpty`.
 */
import { useMemo } from "react";
import { BellRing, Check, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { formatDateOrRelative } from "@/lib/format";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { useTranslations } from "@/lib/i18n/context";
import { useAiCapability } from "@/hooks/use-ai-capability";
import {
  useCoachReminders,
  useCoachReminderMutations,
  type CoachReminderDTO,
} from "@/hooks/use-coach-reminders";

const DUE_STATUSES = new Set(["due", "surfaced"]);

export function CoachRemindersSection({
  isAuthenticated,
  hideWhenEmpty = false,
}: {
  isAuthenticated: boolean;
  /** Render nothing while there are no stored reminders (the Coach-off mount). */
  hideWhenEmpty?: boolean;
}) {
  const { t } = useTranslations();
  // Unavailable (including the loading frame) means read-only: the lifecycle
  // controls appear only once the account says the Coach can be used.
  const readOnly = !useAiCapability("coach").available;
  const query = useCoachReminders({ enabled: isAuthenticated });
  const { setStatus, remove } = useCoachReminderMutations();

  const reminders = useMemo(() => query.data ?? [], [query.data]);
  const { due, rest } = useMemo(() => {
    const due: CoachReminderDTO[] = [];
    const rest: CoachReminderDTO[] = [];
    for (const r of reminders) {
      (DUE_STATUSES.has(r.status) ? due : rest).push(r);
    }
    return { due, rest };
  }, [reminders]);

  const pendingId =
    (setStatus.isPending && setStatus.variables?.id) ||
    (remove.isPending && remove.variables) ||
    null;

  const row = (r: CoachReminderDTO, highlighted: boolean) => {
    const busy = pendingId === r.id;
    const isProposed = r.status === "proposed";
    return (
      <li
        key={r.id}
        data-testid="settings-coach-reminder"
        data-status={r.status}
        className={
          highlighted
            ? "border-primary/40 bg-primary/5 flex flex-col gap-2 rounded-lg border p-3"
            : "border-border bg-background flex flex-col gap-2 rounded-lg border p-3"
        }
      >
        <p className="text-sm break-words">{r.note}</p>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {r.metric && <span className="uppercase">{r.metric}</span>}
          {r.dueAt && (
            <span>
              {t("settings.ai.coachReminders.duePrefix", {
                when: formatDateOrRelative(r.dueAt, t),
              })}
            </span>
          )}
          <span>{t(`settings.ai.coachReminders.status.${r.status}`)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!readOnly && isProposed && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-9"
              disabled={!isAuthenticated || busy}
              data-testid="settings-coach-reminder-confirm"
              onClick={() => setStatus.mutate({ id: r.id, status: "active" })}
            >
              <Check className="size-3.5" aria-hidden />
              {t("settings.ai.coachReminders.confirm")}
            </Button>
          )}
          {!readOnly && r.status !== "done" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-9"
              disabled={!isAuthenticated || busy}
              data-testid="settings-coach-reminder-done"
              onClick={() => setStatus.mutate({ id: r.id, status: "done" })}
            >
              <Check className="size-3.5" aria-hidden />
              {t("settings.ai.coachReminders.markDone")}
            </Button>
          )}
          {!readOnly && (r.status === "due" || r.status === "surfaced") && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-9"
              disabled={!isAuthenticated || busy}
              data-testid="settings-coach-reminder-dismiss"
              onClick={() =>
                setStatus.mutate({ id: r.id, status: "dismissed" })
              }
            >
              <X className="size-3.5" aria-hidden />
              {t("settings.ai.coachReminders.dismiss")}
            </Button>
          )}
          <ConfirmButton
            slot="coach-reminder-delete"
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground min-h-9"
            disabled={!isAuthenticated}
            pending={busy}
            ariaLabel={t("settings.ai.coachReminders.deleteAria")}
            label=""
            icon={<Trash2 className="size-3.5" aria-hidden />}
            title={t("settings.ai.coachReminders.deleteConfirmTitle")}
            body={t("settings.ai.coachReminders.deleteConfirmBody")}
            confirmLabel={t("settings.ai.coachReminders.deleteConfirmAction")}
            onConfirm={() => remove.mutate(r.id)}
          />
        </div>
      </li>
    );
  };

  if (hideWhenEmpty && (query.isPending || query.isError)) return null;
  if (hideWhenEmpty && reminders.length === 0) return null;

  return (
    <SettingsCard
      as="section"
      aria-labelledby="settings-ai-coach-reminders-title"
      data-testid="settings-coach-reminders-card"
    >
      <SettingsCardHeader
        icon={BellRing}
        titleId="settings-ai-coach-reminders-title"
        title={t("settings.ai.coachReminders.title")}
        description={t("settings.ai.coachReminders.description")}
      />
      <p className="text-sm" data-slot="coach-reminders-detail">
        {readOnly
          ? t("settings.ai.coachReminders.readOnlyNote")
          : t("settings.ai.coachReminders.detail")}
      </p>

      {query.isError && (
        <QueryErrorRow
          message={t("settings.ai.coachReminders.loadError")}
          onRetry={() => query.refetch()}
        />
      )}

      {!query.isError && reminders.length === 0 ? (
        <EmptyState
          data-testid="settings-coach-reminders-empty"
          variant="plain"
          size="compact"
          title={t("settings.ai.coachReminders.empty")}
        />
      ) : (
        <div className="space-y-4">
          {due.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                {t("settings.ai.coachReminders.dueHeading")}
              </h3>
              <ul className="space-y-2">{due.map((r) => row(r, true))}</ul>
            </div>
          )}
          {rest.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                {t("settings.ai.coachReminders.allHeading")}
              </h3>
              <ul className="space-y-2">{rest.map((r) => row(r, false))}</ul>
            </div>
          )}
        </div>
      )}

      <p className="text-muted-foreground border-border border-t pt-3 text-xs">
        {t("settings.ai.coachReminders.note")}
      </p>
    </SettingsCard>
  );
}
