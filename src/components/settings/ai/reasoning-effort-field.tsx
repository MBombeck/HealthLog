"use client";

/* ────────────────────────────────────────────────────────────────
 * Reasoning select (#1126) for the Local and OpenAI-compatible forms.
 * Same Label + NativeSelect + hint layout as the model field above it.
 * The empty value is Default: nothing is sent and the model decides.
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
}: {
  id: string;
  /** Locks the select while a write is in flight. */
  disabled?: boolean;
  value: ReasoningEffort | null;
  onChange: (next: ReasoningEffort | null) => void;
}) {
  const { t } = useTranslations();
  return (
    <div>
      <Label htmlFor={id}>{t("settings.ai.reasoning.label")}</Label>
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
        <option value="">{t("settings.ai.reasoning.options.default")}</option>
        <option value="none">{t("settings.ai.reasoning.options.none")}</option>
        <option value="low">{t("settings.ai.reasoning.options.low")}</option>
        <option value="medium">
          {t("settings.ai.reasoning.options.medium")}
        </option>
        <option value="high">{t("settings.ai.reasoning.options.high")}</option>
      </NativeSelect>
      <p id={`${id}-hint`} className="text-muted-foreground mt-1 text-xs">
        {t("settings.ai.reasoning.hint")}
      </p>
    </div>
  );
}
