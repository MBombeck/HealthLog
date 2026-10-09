"use client";

/**
 * v1.4.47 W3 — Coach activation toggle card.
 *
 * v1.18.0 (S5) — moved out of Settings → AI into the dedicated Coach
 * section; its `<section>` id namespace is `settings-coach-activate-*`
 * accordingly. (The file path stays under `ai/` as pre-existing drift.)
 *
 * v1.18.1 (D7) — polarity flip. The card now reads "Activate Coach" with the
 * Switch ON by default (the Coach is on for everyone unless the user opts
 * out). The persisted state is still the single `User.disableCoach` field —
 * one source of truth — so the Switch's `checked` is `!disableCoach` and a
 * flip writes `disableCoach: !next`. Presenting it as activate/default-on is
 * a pure UI inversion over the same column.
 *
 * Persists via `PATCH /api/auth/me/disable-coach`; the response invalidates
 * `aiInputDependentKeys` (the account payload first) so every Coach mount point on the client
 * (`<LayoutCoachFab>`, `<LayoutCoachMount>`, the inline `<CoachLaunchButton>`
 * pill, the `/targets` page CTAs) re-renders with the new `user.disableCoach`
 * value on the next React Query refetch tick — no full reload required.
 *
 * The optimistic-update pattern mirrors `<MoodReminderCard>`: the Switch
 * flips immediately, the mutation rolls back on error.
 *
 * v1.16.4 — header follows the shared `SettingsCardHeader` contract (icon
 * column + title + switch in the status slot) so the card reads like its
 * siblings instead of carrying its own bespoke header row.
 */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageCircleHeart } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { apiPatch } from "@/lib/api/api-fetch";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { useTranslations } from "@/lib/i18n/context";
import { aiInputDependentKeys, invalidateKeys } from "@/lib/query-keys";

export function DisableCoachCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  // Optimistic-update flag — null means "no in-flight change",
  // otherwise it overrides the wire value until the mutation
  // settles. Mirrors the `<MoodReminderCard>` pattern so the Switch
  // reacts instantly to the user's tap.
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

  // v1.4.48 M2 — auto-clear the inline `<p role="status">` line 3 s
  // after the mutation settles so a Settings card the user scrolled
  // past minutes earlier doesn't keep echoing a stale "Coach hidden"
  // banner. The ref tracks the in-flight timer so we can clear it on
  // unmount + on a follow-up toggle (otherwise a rapid double-tap
  // could leave a stray timer pointing at a stale message).
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

  // `mounted`-gated: `user` comes from the auth query, which can resolve
  // before this boundary hydrates — the Switch state must match the SSR HTML
  // during hydration (React #418) and pick up the wire value on the first
  // client re-render. v1.18.1 (D7) — the toggle now reads "Coach aktivieren"
  // (default ON), so the Switch is checked when the Coach is ACTIVE. The
  // persisted column is still `disableCoach`; `optimistic` and `checked` are
  // the activated-state view of it. The SSR default is ON (checked) so the
  // default-on contract holds before the wire value resolves.
  const mounted = useMounted();
  const activated = mounted
    ? (optimistic ?? !(user?.disableCoach ?? false))
    : true;

  const mutation = useMutation({
    // `next` is the desired ACTIVATED state; the column stores the inverse.
    mutationFn: async (next: boolean) => {
      await apiPatch("/api/auth/me/disable-coach", { disableCoach: !next });
      return next;
    },
    onSuccess: (next) => {
      setMsg(
        next
          ? t("settings.coach.activate.savedOn")
          : t("settings.coach.activate.savedOff"),
      );
      setMsgType("success");
      // Surface the new value to every Coach gate via the shared
      // `useAuth()` query — the gates re-render once React Query
      // re-fetches /api/auth/me with the updated `disableCoach` field.
      void invalidateKeys(queryClient, aiInputDependentKeys);
      setOptimistic(null);
      scheduleClear();
    },
    onError: (err) => {
      setOptimistic(null);
      setMsg(
        err instanceof Error
          ? err.message
          : t("settings.coach.activate.saveError"),
      );
      setMsgType("error");
      scheduleClear();
    },
  });

  function handleToggle(next: boolean) {
    setOptimistic(next);
    setMsg(null);
    setMsgType(null);
    if (clearTimerRef.current !== null) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    mutation.mutate(next);
  }

  return (
    <SettingsCard
      as="section"
      aria-labelledby="settings-coach-activate-title"
      data-testid="settings-disable-coach-card"
    >
      <SettingsCardHeader
        anchor="coach-activate"
        icon={MessageCircleHeart}
        title={t("settings.coach.activate.title")}
        titleId="settings-coach-activate-title"
        description={t("settings.coach.activate.description")}
        status={
          <Switch
            data-testid="settings-disable-coach-switch"
            checked={activated}
            onCheckedChange={handleToggle}
            disabled={!isAuthenticated || mutation.isPending}
            aria-label={t("settings.coach.activate.toggleAria")}
          />
        }
      />
      {msg && (
        <p
          role="status"
          aria-live="polite"
          className={
            msgType === "error"
              ? "text-destructive mt-3 text-xs"
              : "text-muted-foreground mt-3 text-xs"
          }
        >
          {msg}
        </p>
      )}
    </SettingsCard>
  );
}
