"use client";

/**
 * v1.41 — how hard the Coach thinks before it answers: one select, Off / Low
 * / Medium / High, Medium by default.
 *
 * The person's own choice lives in `coachPrefsJson.reasoning`. What the
 * server resolved from it rides `/api/auth/me` as `coachReasoning`: whether
 * the operator allows reasoning at all, the highest level they allow, and
 * whether "off" is really off on the active provider. The field renders from
 * that and never recomputes it:
 *  - the operator switched reasoning off: the select is locked and one
 *    sentence says so;
 *  - a level above the operator's cap is offered but disabled, with
 *    "(limited by the admin)";
 *  - where the provider cannot switch thinking off, "Off" reads "Minimal".
 * A server older than v1.41 sends no block; the field then reads as allowed,
 * uncapped and really off.
 *
 * Two homes, one field: the Coach's quick settings (saves on change) and
 * Settings → Coach (part of that card's draft and save).
 */
import { useQueryClient } from "@tanstack/react-query";

import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { useTranslations } from "@/lib/i18n/context";
import { useCoachReasoning } from "@/hooks/use-ai-capability";
import { useCoachPrefs, useSaveCoachPrefs } from "@/hooks/use-coach-prefs";
import { queryKeys } from "@/lib/query-keys";
import {
  DEFAULT_REASONING_LEVEL,
  REASONING_LEVELS,
  REASONING_LEVEL_LABEL_KEYS,
  REASONING_SETTING_KEYS,
  isReasoningLevel,
  type ReasoningLevel,
} from "@/lib/ai/reasoning/levels";
import type { CoachReasoningState } from "@/lib/ai/reasoning/resolve";
import { coachReasoningLevel } from "@/lib/validations/coach-prefs";

export type { CoachReasoningState };

/**
 * The block as the field reads it: the server's answer, or for a server that
 * does not publish one (older than v1.41) "allowed, uncapped, really off" at
 * the default level.
 */
export function reasoningStateOrDefault(
  state: CoachReasoningState | null | undefined,
): CoachReasoningState {
  return (
    state ?? {
      level: DEFAULT_REASONING_LEVEL,
      preference: DEFAULT_REASONING_LEVEL,
      maxLevel: "high",
      available: true,
      offIsReal: true,
      source: "user",
    }
  );
}

/** True when the operator switched reasoning off: the field is locked. */
export function reasoningLocked(state: CoachReasoningState): boolean {
  return state.maxLevel === "off" || state.source === "admin_off";
}

export interface ReasoningOption {
  value: ReasoningLevel;
  label: string;
  disabled: boolean;
}

/** The four options in order, labelled and capped for this account. */
export function reasoningOptions(
  state: CoachReasoningState,
  t: (key: string) => string,
): ReasoningOption[] {
  const locked = reasoningLocked(state);
  const cap = REASONING_LEVELS.indexOf(state.maxLevel);
  return REASONING_LEVELS.map((value, index) => {
    const base = t(
      value === "off" && !state.offIsReal
        ? REASONING_LEVEL_LABEL_KEYS.minimal
        : REASONING_LEVEL_LABEL_KEYS[value],
    );
    // Above the cap is "(limited by the admin)"; while reasoning is off the
    // one sentence under the field says it, not every option.
    const capped = !locked && index > cap;
    return {
      value,
      label: capped ? `${base} ${t(REASONING_SETTING_KEYS.capped)}` : base,
      disabled: capped,
    };
  });
}

/**
 * The level the select shows: the person's choice, lowered to the cap when
 * it is above it (that is what runs), and the resolved level while the
 * operator has reasoning off.
 */
export function shownReasoningLevel(
  choice: ReasoningLevel,
  state: CoachReasoningState,
): ReasoningLevel {
  if (reasoningLocked(state)) return state.level;
  return REASONING_LEVELS.indexOf(choice) >
    REASONING_LEVELS.indexOf(state.maxLevel)
    ? state.maxLevel
    : choice;
}

export interface CoachReasoningSelectProps {
  id: string;
  value: ReasoningLevel;
  state: CoachReasoningState;
  /** Locks the select while a write is in flight. */
  busy?: boolean;
  onChange: (next: ReasoningLevel) => void;
}

/** The field itself, without data: what the tests render. */
export function CoachReasoningSelect({
  id,
  value,
  state,
  busy = false,
  onChange,
}: CoachReasoningSelectProps) {
  const { t } = useTranslations();
  const options = reasoningOptions(state, t);
  const locked = reasoningLocked(state);
  return (
    <div data-slot="coach-reasoning-field">
      <Label htmlFor={id} noColon>
        {t(REASONING_SETTING_KEYS.label)}
      </Label>
      <NativeSelect
        id={id}
        data-slot="coach-reasoning-select"
        data-locked={locked ? "true" : undefined}
        className="mt-1"
        value={shownReasoningLevel(value, state)}
        disabled={locked || busy}
        aria-describedby={`${id}-hint`}
        onChange={(e) => {
          const next = e.target.value;
          if (isReasoningLevel(next) && next !== value) onChange(next);
        }}
      >
        {options.map((option) => (
          <option
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </option>
        ))}
      </NativeSelect>
      <p id={`${id}-hint`} className="text-muted-foreground mt-1 text-xs">
        {t(
          locked
            ? REASONING_SETTING_KEYS.disabled
            : REASONING_SETTING_KEYS.hint,
        )}
      </p>
    </div>
  );
}

/** The quick-settings field: reads the saved choice and saves on change. */
export function CoachReasoningField({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const reasoning = useCoachReasoning();
  const prefs = useCoachPrefs();
  const save = useSaveCoachPrefs({
    // The resolved block on `/me` follows the saved choice.
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.authMe() }),
  });
  if (!prefs.data) return null;
  const current = prefs.data;
  const state = reasoningStateOrDefault(reasoning);
  return (
    <CoachReasoningSelect
      id={id}
      value={coachReasoningLevel(current)}
      state={state}
      busy={save.isPending}
      onChange={(reasoning) => save.mutate({ ...current, reasoning })}
    />
  );
}
