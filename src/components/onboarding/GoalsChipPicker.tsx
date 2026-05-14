"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Brain,
  Droplet,
  HeartPulse,
  Moon,
  Pill,
  Scale,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/**
 * v1.4.25 W14b-Content — onboarding step 1 (goals).
 *
 * Multi-select chip picker for the metrics the user wants to track.
 * The goal slugs match a stable enum (used by the eventual
 * `User.onboardingGoals` column in v1.4.26 — for now we hold the
 * selection in client state and bundle it into the final-step submit).
 *
 * Persistence — per the W14b-Content brief — happens in localStorage
 * scoped by `user.id` (mirrors the family-shared-device pattern from
 * `tour-launcher.tsx:59–65`). The Welcome carousel doesn't write here,
 * so a user who closes the tab on step 1 sees their previous choice
 * pre-selected when they resume.
 *
 * CTAs:
 *   - Back   → `/onboarding/0`
 *   - Skip   → advance with empty goal set
 *   - Next   → advance with chosen goal set
 *
 * Both Skip and Next call POST `/api/onboarding/step` with `{ step: 2 }`
 * and `router.push("/onboarding/2")`.
 */

export const ONBOARDING_GOALS_STORAGE_PREFIX = "healthlog.onboarding.goals";

export type OnboardingGoalSlug =
  | "weight-management"
  | "bp-tracking"
  | "glucose-tracking"
  | "sleep-improvement"
  | "medication-compliance"
  | "general-wellness";

interface GoalOption {
  slug: OnboardingGoalSlug;
  Icon: LucideIcon;
  labelKey: string;
}

const GOAL_OPTIONS: ReadonlyArray<GoalOption> = [
  {
    slug: "weight-management",
    Icon: Scale,
    labelKey: "onboarding.goals.options.weightManagement",
  },
  {
    slug: "bp-tracking",
    Icon: HeartPulse,
    labelKey: "onboarding.goals.options.bpTracking",
  },
  {
    slug: "glucose-tracking",
    Icon: Droplet,
    labelKey: "onboarding.goals.options.glucoseTracking",
  },
  {
    slug: "sleep-improvement",
    Icon: Moon,
    labelKey: "onboarding.goals.options.sleepImprovement",
  },
  {
    slug: "medication-compliance",
    Icon: Pill,
    labelKey: "onboarding.goals.options.medicationCompliance",
  },
  {
    slug: "general-wellness",
    Icon: Brain,
    labelKey: "onboarding.goals.options.generalWellness",
  },
];

export function goalsStorageKey(userId: string): string {
  return `${ONBOARDING_GOALS_STORAGE_PREFIX}:${userId}`;
}

function readGoalsFromStorage(
  storageKey: string,
): Set<OnboardingGoalSlug> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    const allowed = new Set<string>(GOAL_OPTIONS.map((o) => o.slug));
    const out = new Set<OnboardingGoalSlug>();
    for (const v of parsed) {
      if (typeof v === "string" && allowed.has(v)) {
        out.add(v as OnboardingGoalSlug);
      }
    }
    return out;
  } catch {
    /* corrupt entry — ignore */
    return new Set();
  }
}

export interface GoalsChipPickerProps {
  /**
   * The current user's id. Threaded in from the server step page
   * (`getSession().user.id`) so the localStorage hydration can run
   * synchronously in the state initializer and avoid the
   * `react-hooks/set-state-in-effect` cascading-render anti-pattern.
   */
  userId: string;
}

export function GoalsChipPicker({ userId }: GoalsChipPickerProps) {
  const { t } = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();

  const storageKey = goalsStorageKey(userId);

  const [selected, setSelected] = useState<Set<OnboardingGoalSlug>>(() =>
    readGoalsFromStorage(storageKey),
  );
  const [advancing, setAdvancing] = useState(false);

  const toggle = useCallback((slug: OnboardingGoalSlug) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }, []);

  // Persist on every change. localStorage is cheap and the goal set is
  // tiny — no need for a debounced effect here.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify(Array.from(selected)),
      );
    } catch {
      /* quota or disabled — best-effort */
    }
  }, [storageKey, selected]);

  async function advance() {
    if (advancing) return;
    setAdvancing(true);
    try {
      const res = await fetch("/api/onboarding/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: 2 }),
      });
      if (!res.ok) throw new Error(await readError(res));
      await queryClient.invalidateQueries({ queryKey: ["auth"] });
      router.push("/onboarding/2");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t("onboarding.errorGeneric");
      toast.error(message);
      setAdvancing(false);
    }
  }

  return (
    <section
      aria-labelledby="onboarding-goals-title"
      className="space-y-6"
    >
      <header className="space-y-2">
        <h1
          id="onboarding-goals-title"
          tabIndex={-1}
          className="text-2xl font-semibold tracking-tight"
        >
          {t("onboarding.goals.title")}
        </h1>
        <p className="text-muted-foreground text-base leading-relaxed">
          {t("onboarding.goals.body")}
        </p>
        <p className="text-muted-foreground text-xs">
          {t("onboarding.goals.helpHint")}
        </p>
      </header>

      <fieldset
        className="grid grid-cols-2 gap-3 sm:grid-cols-3"
        aria-describedby="onboarding-goals-title"
      >
        <legend className="sr-only">{t("onboarding.goals.title")}</legend>
        {GOAL_OPTIONS.map((option) => {
          const checked = selected.has(option.slug);
          const Icon = option.Icon;
          return (
            <label
              key={option.slug}
              className={cn(
                "border-border bg-card flex min-h-[88px] cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border p-3 text-center transition-colors duration-150 ease-out motion-reduce:transition-none",
                "hover:border-primary/50",
                checked && "border-primary bg-primary/5",
              )}
            >
              <input
                type="checkbox"
                name="onboarding-goal"
                value={option.slug}
                checked={checked}
                onChange={() => toggle(option.slug)}
                className="sr-only"
              />
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-9 items-center justify-center rounded-full transition-colors",
                  checked
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground",
                )}
              >
                <Icon className="size-4" />
              </span>
              <span className="text-foreground text-sm font-medium leading-tight">
                {t(option.labelKey)}
              </span>
            </label>
          );
        })}
      </fieldset>

      <div className="flex items-center justify-between gap-2 pt-2">
        <Button asChild variant="ghost" className="min-h-11 min-w-11">
          <Link href="/onboarding/0">{t("onboarding.shell.back")}</Link>
        </Button>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={advance}
            disabled={advancing}
            className="min-h-11 min-w-11"
          >
            {t("onboarding.shell.skip")}
          </Button>
          <Button
            type="button"
            onClick={advance}
            disabled={advancing}
            className="min-h-11 min-w-11"
          >
            {t("onboarding.shell.next")}
          </Button>
        </div>
      </div>
    </section>
  );
}

async function readError(res: Response): Promise<string> {
  try {
    const json = (await res.json()) as { error?: string };
    if (typeof json.error === "string" && json.error.length > 0) {
      return json.error;
    }
  } catch {
    /* fall through */
  }
  return `Request failed (${res.status})`;
}
