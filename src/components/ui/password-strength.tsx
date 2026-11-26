"use client";

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
  getZxcvbnTranslations,
  PASSWORD_STRENGTH_MAX_LENGTH,
} from "@/lib/zxcvbn-i18n";
import { useTranslations } from "@/lib/i18n/context";
import { apiFetch } from "@/lib/api/api-fetch";
import type { PasswordStrengthEstimate } from "@/lib/auth/password";

const ESTIMATE_DEBOUNCE_MS = 200;

interface PasswordStrengthProps {
  password: string;
  minLength?: number;
}

// Both the bar fill and the label route through the AA-tuned semantic tokens
// — the raw Tailwind 500 tones failed contrast against the white card and
// drift off the app's token vocabulary. Weakest two bands are destructive,
// the middle band warning, the strong two bands success; fill and text share
// the same tone per score so the meter reads as one signal.
const SCORE_COLORS = [
  { color: "bg-destructive", textColor: "text-destructive" },
  { color: "bg-destructive", textColor: "text-destructive" },
  { color: "bg-warning", textColor: "text-warning" },
  { color: "bg-success", textColor: "text-success" },
  { color: "bg-success", textColor: "text-success" },
];

export function PasswordStrength({
  password,
  minLength = 12,
}: PasswordStrengthProps) {
  const { t, locale } = useTranslations();
  const { translate } = useMemo(() => getZxcvbnTranslations(locale), [locale]);
  const [result, setResult] = useState<PasswordStrengthEstimate | null>(null);

  // The estimator runs on the server (`POST /api/auth/password-strength`):
  // its dictionaries are about 375 KB gzip, more than any page of the app.
  // The meter asks once typing pauses and keeps showing the last answer until
  // the next one arrives; a failed request leaves the last answer standing,
  // and the password is scored again on submit either way.
  useEffect(() => {
    if (!password) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResult(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const estimate = await apiFetch<PasswordStrengthEstimate>(
          "/api/auth/password-strength",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              password: password.slice(0, PASSWORD_STRENGTH_MAX_LENGTH),
            }),
            signal: controller.signal,
          },
        );
        setResult(estimate);
      } catch {
        // Aborted by the next keystroke, refused or offline: keep the last
        // answer.
      }
    }, ESTIMATE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [password]);

  if (!password) return null;

  const score = result?.score ?? 0;
  const colors = SCORE_COLORS[score];
  const scoreLabels = [
    t("passwordStrength.veryWeak"),
    t("passwordStrength.weak"),
    t("passwordStrength.acceptable"),
    t("passwordStrength.strong"),
    t("passwordStrength.veryStrong"),
  ];
  const isTooShort = password.length < minLength;
  const labelColor = isTooShort ? "text-destructive" : colors.textColor;

  // Collect feedback
  const feedback: string[] = [];
  if (isTooShort) {
    feedback.push(t("passwordStrength.minLength", { count: minLength }));
  }
  if (result?.warning) {
    feedback.push(translate(result.warning));
  }
  if (result?.suggestions) {
    feedback.push(...result.suggestions.map(translate));
  }

  return (
    <div className="space-y-1.5">
      {/* Bar segments */}
      <div className="flex gap-1">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={cn(
              "h-1.5 flex-1 rounded-full transition-colors",
              i <= score && !isTooShort ? colors.color : "bg-muted",
            )}
          />
        ))}
      </div>

      {/* Label */}
      <div className="flex items-center justify-between">
        <span className={cn("text-xs font-medium", labelColor)}>
          {isTooShort ? t("passwordStrength.tooShort") : scoreLabels[score]}
        </span>
        <span className="text-muted-foreground text-xs">
          {password.length}/{minLength}+ {t("passwordStrength.characters")}
        </span>
      </div>

      {/* Feedback */}
      {feedback.length > 0 && (
        <ul className="text-muted-foreground space-y-0.5 text-xs">
          {feedback.map((f, i) => (
            <li key={i}>• {f}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
