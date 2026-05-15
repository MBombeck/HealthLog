"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, RotateCcw } from "lucide-react";
import { useTranslations } from "@/lib/i18n/context";

interface PhaseConfigData {
  greenValue: number;
  greenMode: "MINUTES" | "PERCENT";
  yellowValue: number;
  yellowMode: "MINUTES" | "PERCENT";
  orangeValue: number;
  orangeMode: "MINUTES" | "PERCENT";
  redValue: number;
  redMode: "MINUTES" | "PERCENT";
}

const DEFAULTS: PhaseConfigData = {
  greenValue: 60,
  greenMode: "MINUTES",
  yellowValue: 30,
  yellowMode: "MINUTES",
  orangeValue: 0,
  orangeMode: "MINUTES",
  redValue: 240,
  redMode: "MINUTES",
};

interface PhaseConfigDialogProps {
  medicationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type PhaseKey = "green" | "yellow" | "orange" | "red";

const PHASES: {
  key: PhaseKey;
  color: string;
  dotClass: string;
  direction: "before" | "after";
}[] = [
  {
    key: "green",
    color: "green",
    dotClass: "bg-green-500",
    direction: "before",
  },
  {
    key: "yellow",
    color: "yellow",
    dotClass: "bg-yellow-500",
    direction: "before",
  },
  {
    key: "orange",
    color: "orange",
    dotClass: "bg-orange-500",
    direction: "after",
  },
  { key: "red", color: "red", dotClass: "bg-red-500", direction: "after" },
];

export function PhaseConfigDialog({
  medicationId,
  open,
  onOpenChange,
}: PhaseConfigDialogProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [localForm, setLocalForm] = useState<PhaseConfigData | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["phase-config", medicationId],
    queryFn: async () => {
      const res = await fetch(`/api/medications/${medicationId}/phase-config`);
      const json = await res.json();
      return json.data as PhaseConfigData;
    },
    enabled: open,
  });

  // Use local overrides if user has edited, otherwise use fetched data or defaults
  const form = localForm ?? data ?? DEFAULTS;

  const saveMutation = useMutation({
    mutationFn: async (config: PhaseConfigData) => {
      const res = await fetch(`/api/medications/${medicationId}/phase-config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (!res.ok) throw new Error("Save failed");
      return res.json();
    },
    onSuccess: () => {
      setLocalForm(null);
      queryClient.invalidateQueries({
        queryKey: ["phase-config", medicationId],
      });
      setStatusMessage(t("medications.phaseSaved"));
      setTimeout(() => setStatusMessage(null), 2000);
    },
  });

  const resetMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/medications/${medicationId}/phase-config`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Reset failed");
      return res.json();
    },
    onSuccess: () => {
      setLocalForm(null);
      queryClient.invalidateQueries({
        queryKey: ["phase-config", medicationId],
      });
      setStatusMessage(t("medications.phaseReset"));
      setTimeout(() => setStatusMessage(null), 2000);
    },
  });

  function updateValue(phase: PhaseKey, value: number) {
    const valueKey = `${phase}Value` as keyof PhaseConfigData;
    setLocalForm({ ...form, [valueKey]: value });
  }

  function toggleMode(phase: PhaseKey) {
    const modeKey = `${phase}Mode` as keyof PhaseConfigData;
    setLocalForm({
      ...form,
      [modeKey]: form[modeKey] === "MINUTES" ? "PERCENT" : "MINUTES",
    });
  }

  const phaseLabel = (key: PhaseKey): string => {
    switch (key) {
      case "green":
        return t("medications.phaseGreen");
      case "yellow":
        return t("medications.phaseYellow");
      case "orange":
        return t("medications.phaseOrange");
      case "red":
        return t("medications.phaseRed");
    }
  };

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("medications.phaseConfig")}
      description={t("medications.phaseConfigDescription")}
      className="sm:max-w-md"
      footer={
        <div className="flex w-full flex-row justify-between gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => resetMutation.mutate()}
            disabled={resetMutation.isPending}
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            {t("medications.phaseResetDefaults")}
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              onClick={() => saveMutation.mutate(form)}
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
              )}
              {t("common.save")}
            </Button>
          </div>
        </div>
      }
    >
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin motion-reduce:animate-none" />
          </div>
        ) : (
          <div className="space-y-3">
            {PHASES.map(({ key, dotClass, direction }) => {
              const valueKey = `${key}Value` as keyof PhaseConfigData;
              const modeKey = `${key}Mode` as keyof PhaseConfigData;
              const value = form[valueKey] as number;
              const mode = form[modeKey] as "MINUTES" | "PERCENT";

              return (
                // v1.4.27 MB7 / CF-50 — stack the row on `<sm` so
                // the input + mode toggle + suffix caption don't
                // overflow the 280-300 px dialog inner width on
                // Galaxy Fold. The dot + phase label stay on the
                // first line; the input / toggle / suffix wrap
                // beneath. At `sm:` the original single-line layout
                // returns because the wider dialog can absorb the
                // five horizontal slots.
                <div
                  key={key}
                  className="flex flex-wrap items-center gap-2 sm:flex-nowrap"
                >
                  <div
                    className={`h-3 w-3 rounded-full ${dotClass} shrink-0`}
                    aria-hidden="true"
                  />
                  <span className="w-14 shrink-0 text-sm font-medium">
                    {phaseLabel(key)}
                  </span>
                  <Input
                    type="number"
                    min={0}
                    max={1440}
                    value={value}
                    onChange={(e) =>
                      updateValue(key, parseInt(e.target.value, 10) || 0)
                    }
                    className="h-8 w-20 text-sm"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 w-12 px-0 text-xs"
                    onClick={() => toggleMode(key)}
                  >
                    {mode === "MINUTES"
                      ? t("medications.phaseMinutes")
                      : t("medications.phasePercent")}
                  </Button>
                  <span className="text-muted-foreground basis-full text-xs sm:basis-auto sm:shrink-0">
                    {direction === "before"
                      ? t("medications.phaseBeforeEnd")
                      : t("medications.phaseAfterEnd")}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {statusMessage && (
          <div className="text-center text-sm text-green-500">
            {statusMessage}
          </div>
        )}
    </ResponsiveSheet>
  );
}
