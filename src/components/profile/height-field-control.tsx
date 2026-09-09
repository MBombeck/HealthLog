"use client";

/**
 * v1.32.30 — the height entry control, shared by the onboarding baseline
 * step and the Settings profile card.
 *
 * The two surfaces own their own label (they sit in different i18n
 * namespaces and different card shells), but the control below is the
 * one place that decides what a height field looks like under a
 * preference. Metric renders the single centimetres box the app has
 * always rendered; imperial renders the feet + inches pair, because a
 * single decimal-inches box is not how anyone states a height.
 *
 * The first input always carries the bare `idPrefix`, so a surrounding
 * `<Label htmlFor={idPrefix}>` resolves on both branches. Every limit
 * comes from the adapter, which rounds them inward against the server's
 * canonical window — see `src/lib/profile/height-unit-display.ts`.
 */
import { Input } from "@/components/ui/input";
import { useTranslations } from "@/lib/i18n/context";
import type {
  HeightDraft,
  HeightUnitAdapter,
} from "@/lib/profile/height-unit-display";

interface HeightFieldControlProps {
  /** Id of the first input; the inches box appends `-inches`. */
  idPrefix: string;
  adapter: HeightUnitAdapter;
  value: HeightDraft;
  onChange: (next: HeightDraft) => void;
  autoComplete?: string;
  enterKeyHint?: "next";
  /** Marks every box of the control as refused. */
  invalid?: boolean;
  /** Id of the error paragraph the control's boxes point at. */
  describedBy?: string;
}

export function HeightFieldControl({
  idPrefix,
  adapter,
  value,
  onChange,
  autoComplete,
  enterKeyHint,
  invalid,
  describedBy,
}: HeightFieldControlProps) {
  const { t } = useTranslations();
  const { bounds } = adapter;

  if (!adapter.usesFeetInches) {
    return (
      <Input
        id={idPrefix}
        type="number"
        inputMode="decimal"
        enterKeyHint={enterKeyHint}
        value={value.cm}
        onChange={(e) => onChange({ ...value, cm: e.target.value })}
        placeholder="175"
        min={bounds.cm.min}
        max={bounds.cm.max}
        step={0.1}
        autoComplete={autoComplete}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
      />
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="flex items-center gap-2">
        <Input
          id={idPrefix}
          type="number"
          inputMode="numeric"
          enterKeyHint={enterKeyHint}
          value={value.feet}
          onChange={(e) => onChange({ ...value, feet: e.target.value })}
          placeholder="5"
          min={bounds.feet.min}
          max={bounds.feet.max}
          step={1}
          autoComplete={autoComplete}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          aria-label={t("common.heightFeet")}
        />
        <span
          aria-hidden="true"
          className="text-muted-foreground shrink-0 text-xs"
        >
          {t("common.feet")}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Input
          id={`${idPrefix}-inches`}
          type="number"
          inputMode="numeric"
          enterKeyHint={enterKeyHint}
          value={value.inches}
          onChange={(e) => onChange({ ...value, inches: e.target.value })}
          placeholder="9"
          min={bounds.inches.min}
          max={bounds.inches.max}
          step={1}
          autoComplete={autoComplete}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          aria-label={t("common.heightInches")}
        />
        <span
          aria-hidden="true"
          className="text-muted-foreground shrink-0 text-xs"
        >
          {t("common.inches")}
        </span>
      </div>
    </div>
  );
}
