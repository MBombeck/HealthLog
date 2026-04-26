"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { getZxcvbnTranslations } from "@/lib/zxcvbn-i18n";
import { useTranslations } from "@/lib/i18n/context";

interface PasswordStrengthProps {
  password: string;
  minLength?: number;
}

const SCORE_COLORS = [
  { color: "bg-red-500", textColor: "text-red-500" },
  { color: "bg-orange-500", textColor: "text-orange-500" },
  { color: "bg-yellow-500", textColor: "text-yellow-500" },
  { color: "bg-green-500", textColor: "text-green-500" },
  { color: "bg-emerald-600", textColor: "text-emerald-600" },
];

export function PasswordStrength({
  password,
  minLength = 12,
}: PasswordStrengthProps) {
  const { t, locale } = useTranslations();
  const { translate } = useMemo(
    () => getZxcvbnTranslations(locale),
    [locale],
  );
  const [result, setResult] = useState<{
    score: number;
    feedback: { warning: string; suggestions: string[] };
  } | null>(null);
  const zxcvbnRef = useRef<typeof import("zxcvbn-typescript").default | null>(
    null,
  );

  useEffect(() => {
    if (!password) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResult(null);
      return;
    }
    let cancelled = false;
    (async () => {
      if (!zxcvbnRef.current) {
        const mod = await import("zxcvbn-typescript");
        zxcvbnRef.current = mod.default;
      }
      if (!cancelled) {
        setResult(zxcvbnRef.current(password));
      }
    })();
    return () => {
      cancelled = true;
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
  const tooShort = password.length < minLength;

  // Collect feedback
  const feedback: string[] = [];
  if (tooShort) {
    feedback.push(t("passwordStrength.minLength", { count: minLength }));
  }
  if (result?.feedback.warning) {
    feedback.push(translate(result.feedback.warning));
  }
  if (result?.feedback.suggestions) {
    feedback.push(...result.feedback.suggestions.map(translate));
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
              i <= score && !tooShort ? colors.color : "bg-muted",
            )}
          />
        ))}
      </div>

      {/* Label */}
      <div className="flex items-center justify-between">
        <span className={cn("text-xs font-medium", colors.textColor)}>
          {tooShort ? t("passwordStrength.tooShort") : scoreLabels[score]}
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
