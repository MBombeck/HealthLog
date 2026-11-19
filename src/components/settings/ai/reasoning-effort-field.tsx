"use client";

/* ────────────────────────────────────────────────────────────────
 * Reasoning select (#1126) for the Local and OpenAI-compatible forms.
 * Same Label + NativeSelect + hint layout as the model field above it.
 * The empty value is Default: nothing is sent and the model decides.
 * v1.41 — the Coach reads its own thinking depth from the Coach settings;
 * a line under the hint says so. #1267 — so do the background jobs (the
 * daily briefing among them); a second line says that too.
 * ──────────────────────────────────────────────────────────────── */

import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { useTranslations } from "@/lib/i18n/context";

import type { ReasoningEffort } from "./shared";

export function ReasoningEffortField({
  id,
  disabled = false,
  value,
  onChange,
  noColon = false,
  allowedLevels,
  showDefault = true,
}: {
  id: string;
  /** Locks the select while a write is in flight. */
  disabled?: boolean;
  value: ReasoningEffort | null;
  onChange: (next: ReasoningEffort | null) => void;
  /** The Coach's quick settings label their fields without a colon. */
  noColon?: boolean;
  /** Allowed options in the dropdown. Defaults to ["none", "low", "medium", "high"]. */
  allowedLevels?: readonly ReasoningEffort[];
  /** Whether to show the Default option. Defaults to true. */
  showDefault?: boolean;
}) {
  const { t } = useTranslations();
  const levels = allowedLevels ?? (["none", "low", "medium", "high"] as const);
  return (
    <div>
      <Label htmlFor={id} noColon={noColon}>
        {t("settings.ai.reasoning.label")}
      </Label>
      <NativeSelect
        id={id}
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) =>
          onChange(
            e.target.value === "" ? null : (e.target.value as ReasoningEffort),
          )
        }
        className="mt-1"
        aria-describedby={`${id}-hint`}
      >
        {showDefault && (
          <option value="">{t("settings.ai.reasoning.options.default")}</option>
        )}
        {levels.map((lvl) => (
          <option key={lvl} value={lvl}>
            {t(`settings.ai.reasoning.options.${lvl}`)}
          </option>
        ))}
      </NativeSelect>
      <p id={`${id}-hint`} className="text-muted-foreground mt-1 text-xs">
        {t("settings.ai.reasoning.hint")}
      </p>
    </div>
  );
}
