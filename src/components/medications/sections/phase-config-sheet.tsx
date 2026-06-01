"use client";

/**
 * v1.5.5 D-3 §9.7 / C-E3-1 — Phase-config editor inside a focused
 * `<ResponsiveSheet>`.
 *
 * Resurrects the v1.5.4 `{ medicationId, open, onOpenChange }` contract
 * but inside a Sheet (mobile bottom / desktop right) instead of inline
 * on the settings row. Mounts only when the parent confirms
 * `treatmentClass === "GLP1"` + a course window is set.
 *
 * Body hosts the four-row green/yellow/orange/red grid with mode
 * (MINUTES / PERCENT) and value inputs, an `[Auf Standard]` reset, and
 * the `[Speichern]` save. The save invalidates
 * `medicationPhaseConfig(id)` + `medicationDependentKeys` then closes.
 *
 * The sheet hosts ONLY the editor form. Per C-E4-4 a row-edit Sheet
 * never carries a destructive action; the only buttons here are
 * "reset to default" (non-destructive — it stays in the form before
 * the user saves) and "save".
 *
 * State pattern: the editor form is keyed by the server snapshot so a
 * fresh server fetch (after the parent invalidates the bundle)
 * replaces local edits with the canonical state. This sidesteps the
 * React-19 "setState in effect" lint rule.
 */

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslations } from "@/lib/i18n/context";
import {
  invalidateKeys,
  medicationDependentKeys,
  queryKeys,
} from "@/lib/query-keys";

type PhaseMode = "MINUTES" | "PERCENT";

interface PhaseRow {
  value: number;
  mode: PhaseMode;
}

interface PhaseConfig {
  green: PhaseRow;
  yellow: PhaseRow;
  orange: PhaseRow;
  red: PhaseRow;
}

const DEFAULT_CONFIG: PhaseConfig = {
  green: { value: 60, mode: "MINUTES" },
  yellow: { value: 30, mode: "MINUTES" },
  orange: { value: 0, mode: "MINUTES" },
  red: { value: 240, mode: "MINUTES" },
};

const PHASE_KEYS: Array<keyof PhaseConfig> = [
  "green",
  "yellow",
  "orange",
  "red",
];

export interface PhaseConfigSheetProps {
  medicationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface PhaseConfigApiPayload {
  greenValue: number;
  greenMode: PhaseMode;
  yellowValue: number;
  yellowMode: PhaseMode;
  orangeValue: number;
  orangeMode: PhaseMode;
  redValue: number;
  redMode: PhaseMode;
}

function fromApi(payload: PhaseConfigApiPayload): PhaseConfig {
  return {
    green: { value: payload.greenValue, mode: payload.greenMode },
    yellow: { value: payload.yellowValue, mode: payload.yellowMode },
    orange: { value: payload.orangeValue, mode: payload.orangeMode },
    red: { value: payload.redValue, mode: payload.redMode },
  };
}

function toApi(cfg: PhaseConfig): PhaseConfigApiPayload {
  return {
    greenValue: cfg.green.value,
    greenMode: cfg.green.mode,
    yellowValue: cfg.yellow.value,
    yellowMode: cfg.yellow.mode,
    orangeValue: cfg.orange.value,
    orangeMode: cfg.orange.mode,
    redValue: cfg.red.value,
    redMode: cfg.red.mode,
  };
}

function snapshotKey(cfg: PhaseConfig): string {
  return [
    cfg.green.mode,
    cfg.green.value,
    cfg.yellow.mode,
    cfg.yellow.value,
    cfg.orange.mode,
    cfg.orange.value,
    cfg.red.mode,
    cfg.red.value,
  ].join("|");
}

export function PhaseConfigSheet({
  medicationId,
  open,
  onOpenChange,
}: PhaseConfigSheetProps) {
  const { t } = useTranslations();

  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.medicationPhaseConfig(medicationId),
    queryFn: async () => {
      const res = await fetch(`/api/medications/${medicationId}/phase-config`);
      if (!res.ok) throw new Error("phase_config_failed");
      return fromApi((await res.json()).data as PhaseConfigApiPayload);
    },
    enabled: open,
    staleTime: 0,
  });

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("medications.phaseConfig")}
      description={t("medications.phaseConfigDescription")}
    >
      {isLoading ? (
        <div
          className="flex h-32 items-center justify-center"
          role="status"
          aria-busy="true"
          aria-live="polite"
        >
          <Loader2
            aria-hidden="true"
            className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none"
          />
        </div>
      ) : isError ? (
        <p
          className="text-destructive text-sm"
          role="alert"
          data-slot="phase-config-error"
        >
          {t("common.loadFailed")}
        </p>
      ) : data ? (
        <PhaseConfigForm
          key={snapshotKey(data)}
          medicationId={medicationId}
          initial={data}
          onClose={() => onOpenChange(false)}
        />
      ) : null}
    </ResponsiveSheet>
  );
}

function PhaseConfigForm({
  medicationId,
  initial,
  onClose,
}: {
  medicationId: string;
  initial: PhaseConfig;
  onClose: () => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [cfg, setCfg] = useState<PhaseConfig>(initial);
  const [saving, setSaving] = useState(false);

  const labels = useMemo(
    () => ({
      green: t("medications.phaseGreen"),
      yellow: t("medications.phaseYellow"),
      orange: t("medications.phaseOrange"),
      red: t("medications.phaseRed"),
    }),
    [t],
  );

  function patch(key: keyof PhaseConfig, partial: Partial<PhaseRow>) {
    setCfg((prev) => ({ ...prev, [key]: { ...prev[key], ...partial } }));
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/medications/${medicationId}/phase-config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toApi(cfg)),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        toast.error(
          (json as { error?: string }).error ??
            t("medications.detail.phases.saveFailed"),
        );
        return;
      }
      await invalidateKeys(queryClient, [
        ...medicationDependentKeys,
        queryKeys.medicationPhaseConfig(medicationId),
      ]);
      toast.success(t("medications.phaseSaved"));
      onClose();
    } catch {
      toast.error(t("medications.detail.phases.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3" data-slot="phase-config-grid">
        {PHASE_KEYS.map((key) => {
          const inputId = `phase-config-${key}-value`;
          return (
            <div
              key={key}
              className="grid grid-cols-[1fr_auto_120px] items-end gap-2"
            >
              <Label htmlFor={inputId} className="text-sm font-medium">
                {labels[key]}
              </Label>
              <Select
                value={cfg[key].mode}
                onValueChange={(v) => patch(key, { mode: v as PhaseMode })}
              >
                <SelectTrigger
                  className="w-[100px]"
                  aria-label={t("medications.detail.phases.modeLabel", {
                    phase: labels[key],
                  })}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MINUTES">
                    {t("medications.phaseMinutes")}
                  </SelectItem>
                  <SelectItem value="PERCENT">
                    {t("medications.phasePercent")}
                  </SelectItem>
                </SelectContent>
              </Select>
              <Input
                id={inputId}
                type="number"
                min={0}
                max={1440}
                value={cfg[key].value}
                onChange={(e) =>
                  patch(key, { value: Number(e.target.value) || 0 })
                }
                className="text-right"
              />
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => setCfg(DEFAULT_CONFIG)}
          disabled={saving}
          className="min-h-11 sm:min-h-9"
          data-slot="phase-config-reset"
        >
          {t("medications.phaseResetDefaults")}
        </Button>
        <Button
          onClick={() => void save()}
          disabled={saving}
          aria-busy={saving || undefined}
          className="min-h-11 sm:min-h-9"
          data-slot="phase-config-save"
        >
          {saving && (
            <Loader2
              aria-hidden="true"
              className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none"
            />
          )}
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
}
