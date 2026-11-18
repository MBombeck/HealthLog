"use client";

/**
 * The model picker in the Antigravity settings card. It lists the models the
 * CLI reports for the user's profile. The chosen model is saved by the parent.
 */
import { NativeSelect } from "@/components/ui/native-select";
import type { AntigravityModel } from "@/lib/ai/antigravity-client";
import { useTranslations } from "@/lib/i18n/context";

interface AntigravityModelPickerProps {
  models: AntigravityModel[];
  /** The saved model, or null for the CLI's default. */
  selectedModel: string | null;
  disabled: boolean;
  /** Shown instead of the picker when the CLI listed no models. */
  emptyText: string;
  onChange: (model: string | null) => void;
}

export function AntigravityModelPicker({
  models,
  selectedModel,
  disabled,
  emptyText,
  onChange,
}: AntigravityModelPickerProps) {
  const { t } = useTranslations();
  const savedModelIsOffered =
    selectedModel === null ||
    models.some((model) => model.id === selectedModel);

  return (
    <div className="space-y-2">
      <label htmlFor="antigravity-model" className="font-medium">
        {t("settings.ai.antigravity.modelLabel")}
      </label>
      {models.length === 0 ? (
        <p className="text-muted-foreground text-sm">{emptyText}</p>
      ) : (
        <>
          <NativeSelect
            id="antigravity-model"
            value={selectedModel ?? ""}
            disabled={disabled}
            onChange={(event) =>
              onChange(event.target.value === "" ? null : event.target.value)
            }
          >
            <option value="">
              {t("settings.ai.antigravity.modelDefault")}
            </option>
            {!savedModelIsOffered && selectedModel && (
              <option value={selectedModel} disabled>
                {selectedModel} (
                {t("settings.ai.antigravity.modelUnavailableTag")})
              </option>
            )}
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </NativeSelect>
          {!savedModelIsOffered && (
            <p className="text-warning text-sm">
              {t("settings.ai.antigravity.modelUnavailable")}
            </p>
          )}
          <p className="text-muted-foreground text-xs">
            {t("settings.ai.antigravity.modelDescription")}
          </p>
        </>
      )}
    </div>
  );
}
