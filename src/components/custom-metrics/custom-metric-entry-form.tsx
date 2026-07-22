"use client";

import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DateTimeField } from "@/components/ui/date-time-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, apiPost } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import type { CustomMetricEntryDto } from "./types";

const NOTE_MAX_LENGTH = 2000;

function parseDecimal(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** Local datetime string (`YYYY-MM-DDTHH:mm`) for "now", for the field default. */
function nowLocal(): string {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  return new Date(d.getTime() - offset * 60 * 1000).toISOString().slice(0, 16);
}

interface CustomMetricEntryFormProps {
  customMetricId: string;
  unit: string;
  onSuccess?: () => void;
  onCancel?: () => void;
  footerSlot?: HTMLElement | null;
}

/**
 * v1.25.5 — log a value against a custom metric. Numeric value + timestamp +
 * optional note. The server snapshots the metric's unit onto the entry.
 */
export function CustomMetricEntryForm({
  customMetricId,
  unit,
  onSuccess,
  onCancel,
  footerSlot,
}: CustomMetricEntryFormProps) {
  const { t } = useTranslations();
  const formId = useId();
  const queryClient = useQueryClient();

  const [value, setValue] = useState("");
  const [measuredAt, setMeasuredAt] = useState(() => nowLocal());
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const numeric = parseDecimal(value);
    if (numeric === null) {
      setError(t("customMetrics.entry.valueError"));
      return;
    }
    const measuredDate = new Date(measuredAt);
    if (Number.isNaN(measuredDate.getTime())) {
      setError(t("customMetrics.entry.timestampError"));
      return;
    }

    const body = {
      value: numeric,
      measuredAt: measuredDate.toISOString(),
      ...(note.trim() ? { note: note.trim() } : {}),
    };

    setSubmitting(true);
    try {
      await apiPost<CustomMetricEntryDto>(
        `/api/custom-metrics/${customMetricId}/entries`,
        body,
      );
      toast.success(t("customMetrics.entry.savedToast"));
      queryClient.invalidateQueries({ queryKey: queryKeys.customMetrics() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.customMetricDetail(customMetricId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.customMetricEntriesPrefix(customMetricId),
      });
      onSuccess?.();
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : t("customMetrics.entry.saveError");
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  const footerNode = (
    <>
      {onCancel ? (
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={submitting}
        >
          {t("common.cancel")}
        </Button>
      ) : null}
      <Button type="submit" form={formId} disabled={submitting}>
        {submitting ? (
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        ) : null}
        {t("common.save")}
      </Button>
    </>
  );

  return (
    <form id={formId} onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="custom-metric-value">
            {t("customMetrics.entry.value")}
            {unit ? ` (${unit})` : ""}
          </Label>
          <Input
            id="custom-metric-value"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="custom-metric-measuredAt">
            {t("customMetrics.entry.measuredAt")}
          </Label>
          <DateTimeField
            id="custom-metric-measuredAt"
            value={measuredAt}
            onChange={setMeasuredAt}
            required
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="custom-metric-note">
          {t("customMetrics.entry.note")}
        </Label>
        <Textarea
          id="custom-metric-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={NOTE_MAX_LENGTH}
          rows={2}
        />
      </div>

      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      {footerSlot ? (
        createPortal(footerNode, footerSlot)
      ) : (
        <div className="flex justify-end gap-2">{footerNode}</div>
      )}
    </form>
  );
}
