"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ruler } from "lucide-react";

import { SettingsCardHeader } from "@/components/settings/_card-header";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useRovingRadioGroup } from "@/hooks/use-roving-radio-group";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

type UnitPreference = "metric" | "imperial";

/**
 * v1.7.0 — Settings → Display metric/imperial control.
 *
 * The W7 backend (`GET/PATCH /api/auth/me/unit-preference`) and the
 * `useAuth().unitPreference` field shipped without a visible toggle.
 * This card is the follow-up surface: a two-option segmented control
 * that reads the current value from `useAuth()` and PATCHes the
 * endpoint on change. The mutation invalidates `queryKeys.authMe()`
 * so every chart display transform that keys off `unitPreference`
 * (km/h vs mph, km vs mi) re-renders on the next /me refetch — no
 * manual reload.
 */
export function UnitPreferenceCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const [optimistic, setOptimistic] = useState<UnitPreference | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

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

  const value: UnitPreference = optimistic ?? user?.unitPreference ?? "metric";

  const mutation = useMutation({
    mutationFn: async (next: UnitPreference) => {
      const res = await fetch("/api/auth/me/unit-preference", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unitPreference: next }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      return next;
    },
    onSuccess: () => {
      setMsg(t("settings.dashboard.units.saved"));
      setMsgType("success");
      // Refresh `useAuth().unitPreference` so the chart display
      // transforms re-render on the next /api/auth/me refetch.
      queryClient.invalidateQueries({ queryKey: queryKeys.authMe() });
      // Keep the dedicated read in sync for any future consumer.
      queryClient.invalidateQueries({
        queryKey: queryKeys.userUnitPreference(),
      });
      setOptimistic(null);
      scheduleClear();
    },
    onError: (err) => {
      setOptimistic(null);
      setMsg(
        err instanceof Error
          ? err.message
          : t("settings.dashboard.units.saveError"),
      );
      setMsgType("error");
      scheduleClear();
    },
  });

  function handleSelect(next: UnitPreference) {
    if (next === value || mutation.isPending || !isAuthenticated) return;
    setOptimistic(next);
    setMsg(null);
    setMsgType(null);
    if (clearTimerRef.current !== null) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    mutation.mutate(next);
  }

  const options: ReadonlyArray<{ key: UnitPreference; label: string }> = [
    { key: "metric", label: t("settings.dashboard.units.metric") },
    { key: "imperial", label: t("settings.dashboard.units.imperial") },
  ];

  const optionsDisabled = !isAuthenticated || mutation.isPending;
  const { getRadioProps } = useRovingRadioGroup({
    count: options.length,
    selectedIndex: options.findIndex((o) => o.key === value),
    onSelect: (index) => handleSelect(options[index]!.key),
    isDisabled: () => optionsDisabled,
  });

  return (
    <section
      aria-labelledby="settings-units-title"
      data-testid="settings-unit-preference-card"
      className="bg-card rounded-lg border p-4 sm:p-6"
    >
      <SettingsCardHeader
        icon={Ruler}
        title={t("settings.dashboard.units.title")}
        titleId="settings-units-title"
        description={t("settings.dashboard.units.description")}
        status={
          <div
            role="radiogroup"
            aria-label={t("settings.dashboard.units.title")}
            data-testid="settings-unit-preference-control"
            className="bg-muted inline-flex rounded-lg p-1"
          >
            {options.map((opt, index) => {
              const selected = value === opt.key;
              return (
                <button
                  key={opt.key}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-testid={`settings-unit-preference-${opt.key}`}
                  disabled={optionsDisabled}
                  onClick={() => handleSelect(opt.key)}
                  {...getRadioProps(index)}
                  className={cn(
                    "min-h-11 rounded-md px-4 text-sm font-medium transition-colors focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-50 sm:min-h-9",
                    selected
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        }
      />
      {msg && (
        <p
          role="status"
          aria-live="polite"
          className={
            msgType === "error"
              ? "text-destructive mt-3 text-sm"
              : "text-muted-foreground mt-3 text-sm"
          }
        >
          {msg}
        </p>
      )}
    </section>
  );
}
