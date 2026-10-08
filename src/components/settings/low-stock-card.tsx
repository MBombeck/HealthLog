"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PackageOpen } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";
import { readUpdatedAtToken, withBaseToken } from "@/lib/api/optimistic-token";

/**
 * v1.16.11 — medication low-stock alert threshold (Settings →
 * Notifications). The threshold is REMAINING RUNWAY: notify when a
 * tracked medication's supply covers fewer than N days (1–60, default
 * 7); the switch off persists `null` (alert off). Reads the same
 * per-user prefs blob the mood / coach cards use and writes through
 * `PATCH /api/auth/me/notification-prefs`; the value also surfaces on
 * `GET /api/settings/reminder-thresholds` for API consumers, so the
 * save invalidates both keys.
 */

interface NotificationPrefsShape {
  medication: { lowStockRunwayDays: number | null; reorderLeadDays?: number };
  // v1.32.22 (R5b) — optimistic-concurrency token, a sibling key on the
  // resolved prefs response, echoed on every PATCH from this card.
  updatedAt?: string;
}

const DEFAULT_DAYS = 7;
const MIN_DAYS = 1;
const MAX_DAYS = 60;
// v1.17.0 — reorder lead time. The alert widens its trigger by this lead
// plus one dose-interval so a refill arrives before the last dose.
const DEFAULT_LEAD = 10;
const MIN_LEAD = 0;
const MAX_LEAD = 60;

export function LowStockCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [optimistic, setOptimistic] = useState<number | null | undefined>(
    undefined,
  );
  const [draft, setDraft] = useState<string | null>(null);
  const [leadDraft, setLeadDraft] = useState<string | null>(null);
  const [leadOptimistic, setLeadOptimistic] = useState<number | undefined>(
    undefined,
  );
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

  // Auto-clear the inline status line 3 s after the mutation settles —
  // the MoodReminderCard pattern, including the unmount / re-toggle
  // timer hygiene.
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current !== null) {
        clearTimeout(clearTimerRef.current);
        clearTimerRef.current = null;
      }
    };
  }, []);

  function scheduleClear() {
    if (clearTimerRef.current !== null) {
      clearTimeout(clearTimerRef.current);
    }
    clearTimerRef.current = setTimeout(() => {
      clearTimerRef.current = null;
      setMsg(null);
      setMsgType(null);
    }, 3000);
  }

  const { data: prefs } = useQuery({
    queryKey: queryKeys.authNotificationPrefs(),
    queryFn: async () => {
      return apiGet<NotificationPrefsShape>("/api/auth/me/notification-prefs");
    },
    enabled: isAuthenticated,
  });

  const persisted =
    prefs?.medication?.lowStockRunwayDays === undefined
      ? DEFAULT_DAYS
      : prefs.medication.lowStockRunwayDays;
  const current = optimistic === undefined ? persisted : optimistic;
  const enabled = current !== null;
  const days = current ?? DEFAULT_DAYS;

  const persistedLead =
    prefs?.medication?.reorderLeadDays === undefined
      ? DEFAULT_LEAD
      : prefs.medication.reorderLeadDays;
  const leadDays =
    leadOptimistic === undefined ? persistedLead : leadOptimistic;

  async function patchPrefs(
    body: Record<string, unknown>,
    successMsg: string,
  ): Promise<boolean> {
    setSaving(true);
    setMsg(null);
    setMsgType(null);
    if (clearTimerRef.current !== null) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }

    // v1.32.22 (R5b) — echo the base token so a concurrent notification-prefs
    // write (the iOS client, another web card) 409s instead of reverting a
    // sibling category through the server-side deep-merge.
    const res = await apiFetchRaw("/api/auth/me/notification-prefs", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        withBaseToken(
          body,
          readUpdatedAtToken(queryClient, queryKeys.authNotificationPrefs()),
        ),
      ),
    });

    if (res.ok) {
      setMsg(successMsg);
      setMsgType("success");
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.authNotificationPrefs(),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.settingsReminderThresholds(),
        }),
      ]);
    } else if (res.status === 409) {
      // The prefs advanced since they were loaded. Refetch (the active query
      // reseeds a fresh token) and nudge — the caller reverts its optimistic
      // value, so the card snaps back to server truth for a re-apply.
      await queryClient.invalidateQueries({
        queryKey: queryKeys.authNotificationPrefs(),
      });
      setMsg(t("common.conflictReloaded"));
      setMsgType("error");
    } else {
      setMsg(t("notifications.lowStock.saveError"));
      setMsgType("error");
    }
    scheduleClear();
    setSaving(false);
    return res.ok;
  }

  async function persist(next: number | null, successMsg: string) {
    setOptimistic(next);
    const ok = await patchPrefs(
      { medication: { lowStockRunwayDays: next } },
      successMsg,
    );
    setOptimistic(undefined);
    void ok;
  }

  async function persistLead(next: number, successMsg: string) {
    setLeadOptimistic(next);
    const ok = await patchPrefs(
      { medication: { reorderLeadDays: next } },
      successMsg,
    );
    setLeadOptimistic(undefined);
    void ok;
  }

  async function handleToggle(next: boolean) {
    await persist(
      next ? days : null,
      next
        ? t("notifications.lowStock.enabledToast")
        : t("notifications.lowStock.disabledToast"),
    );
  }

  function commitDraft() {
    if (draft === null) return;
    const parsed = Number(draft);
    setDraft(null);
    if (!Number.isInteger(parsed)) return;
    const clamped = Math.min(MAX_DAYS, Math.max(MIN_DAYS, parsed));
    if (clamped === days) return;
    void persist(clamped, t("notifications.lowStock.savedToast"));
  }

  function commitLeadDraft() {
    if (leadDraft === null) return;
    const parsed = Number(leadDraft);
    setLeadDraft(null);
    if (!Number.isInteger(parsed)) return;
    const clamped = Math.min(MAX_LEAD, Math.max(MIN_LEAD, parsed));
    if (clamped === leadDays) return;
    void persistLead(clamped, t("notifications.lowStock.leadSavedToast"));
  }

  return (
    <SettingsCard
      as="section"
      // `id` is the anchor target of the supply tab's cross-link
      // (`/settings/notifications#low-stock`) — keep it stable.
      id="low-stock"
      aria-labelledby="settings-low-stock-title"
      className="scroll-mt-28"
    >
      <SettingsCardHeader
        icon={PackageOpen}
        title={t("notifications.lowStock.title")}
        titleId="settings-low-stock-title"
        description={t("notifications.lowStock.description")}
        status={
          <label className="flex min-h-11 items-center gap-3">
            <Switch
              checked={enabled}
              onCheckedChange={handleToggle}
              disabled={!isAuthenticated || saving}
              aria-label={t("notifications.lowStock.toggleAria")}
            />
            <span className="text-muted-foreground text-xs">
              {enabled
                ? t("notifications.lowStock.statusOn")
                : t("notifications.lowStock.statusOff")}
            </span>
          </label>
        }
      />
      <p className="text-sm">{t("notifications.lowStock.detail")}</p>
      {enabled && (
        <div className="flex min-h-11 items-center justify-between gap-3">
          <label htmlFor="low-stock-days" className="text-sm font-medium">
            {t("notifications.lowStock.daysLabel")}
          </label>
          <Input
            id="low-stock-days"
            type="number"
            inputMode="numeric"
            min={MIN_DAYS}
            max={MAX_DAYS}
            className="w-24 text-right tabular-nums"
            value={draft ?? String(days)}
            disabled={!isAuthenticated || saving}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitDraft();
            }}
            aria-label={t("notifications.lowStock.daysAria")}
            autoComplete="off"
            data-lpignore="true"
            data-1p-ignore="true"
          />
        </div>
      )}
      {/* v1.17.0 — reorder lead time. Progressive disclosure: shown only
          while the alert is enabled, with a sensible default (10) most
          users never touch. A single medication can override this on its
          own supply tab. */}
      {enabled && (
        <div>
          <div className="flex min-h-11 items-center justify-between gap-3">
            <label htmlFor="low-stock-lead" className="text-sm font-medium">
              {t("notifications.lowStock.leadLabel")}
            </label>
            <Input
              id="low-stock-lead"
              type="number"
              inputMode="numeric"
              min={MIN_LEAD}
              max={MAX_LEAD}
              className="w-24 text-right tabular-nums"
              value={leadDraft ?? String(leadDays)}
              disabled={!isAuthenticated || saving}
              onChange={(e) => setLeadDraft(e.target.value)}
              onBlur={commitLeadDraft}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitLeadDraft();
              }}
              aria-label={t("notifications.lowStock.leadAria")}
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
            />
          </div>
          <p className="text-muted-foreground mt-1.5 max-w-prose text-xs">
            {t("notifications.lowStock.leadHelp")}
          </p>
        </div>
      )}
      {msg && (
        <p
          role="status"
          aria-live="polite"
          className={
            msgType === "error"
              ? "text-destructive text-sm"
              : "text-muted-foreground text-sm"
          }
        >
          {msg}
        </p>
      )}
      {/* v1.16.11 — back-link to the medications list, the surface the
          alert is about (the supply tab links here the same way). */}
      <p>
        <Link
          href="/medications"
          className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
          data-slot="low-stock-medications-link"
        >
          {t("notifications.lowStock.medicationsLink")}
        </Link>
      </p>
    </SettingsCard>
  );
}
