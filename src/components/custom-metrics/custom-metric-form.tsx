"use client";

import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, apiPatch, apiPost } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";

import type { CustomMetricDto } from "./types";

const DESCRIPTION_MAX_LENGTH = 2000;

/** Parse a free-text decimal that may use a comma separator. */
function parseDecimal(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** Parse a free-text non-negative integer (display decimals). */
function parseInteger(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

interface CustomMetricFormProps {
  /** When set the form edits this metric; otherwise it defines a new one. */
  existing?: CustomMetricDto;
  onSuccess?: (saved: CustomMetricDto) => void;
  onCancel?: () => void;
  /**
   * When mounted inside a `<ResponsiveSheet>` the caller passes the sheet's
   * footer slot element here; the Cancel / Save row portals into it so the
   * bottom-sheet branch can sticky-pin it.
   */
  footerSlot?: HTMLElement | null;
}

/**
 * v1.25.5 — define or edit a custom metric.
 *
 * A metric is the feature's reusable definition: free-text name + unit, an
 * optional target window (set ONCE), optional display decimals, and an optional
 * description. Mirrors the biomarker form; numeric-only, no qualitative path.
 */
export function CustomMetricForm({
  existing,
  onSuccess,
  onCancel,
  footerSlot,
}: CustomMetricFormProps) {
  const { t } = useTranslations();
  const formId = useId();

  const [name, setName] = useState(existing?.name ?? "");
  const [unit, setUnit] = useState(existing?.unit ?? "");
  const [low, setLow] = useState(
    existing?.targetLow != null ? String(existing.targetLow) : "",
  );
  const [high, setHigh] = useState(
    existing?.targetHigh != null ? String(existing.targetHigh) : "",
  );
  const [decimals, setDecimals] = useState(
    existing?.decimals != null ? String(existing.decimals) : "",
  );
  const [description, setDescription] = useState(existing?.description ?? "");
  const [correlationEnabled, setCorrelationEnabled] = useState(
    existing?.correlationEnabled ?? false,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!name.trim() || !unit.trim()) {
      setError(t("customMetrics.form.requiredError"));
      return;
    }

    const lowVal = parseDecimal(low);
    const highVal = parseDecimal(high);
    if (lowVal !== null && highVal !== null && lowVal > highVal) {
      setError(t("customMetrics.form.rangeOrderError"));
      return;
    }
    const decimalsVal = parseInteger(decimals);

    const body = {
      name: name.trim(),
      unit: unit.trim(),
      ...(lowVal !== null ? { targetLow: lowVal } : {}),
      ...(highVal !== null ? { targetHigh: highVal } : {}),
      ...(decimalsVal !== null ? { decimals: decimalsVal } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      correlationEnabled,
    };

    setSubmitting(true);
    try {
      const saved = existing
        ? await apiPatch<CustomMetricDto>(
            `/api/custom-metrics/${existing.id}`,
            body,
          )
        : await apiPost<CustomMetricDto>("/api/custom-metrics", body);
      toast.success(
        existing
          ? t("customMetrics.form.updatedToast")
          : t("customMetrics.form.savedToast"),
      );
      onSuccess?.(saved);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : t("customMetrics.form.saveError");
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
          variant="outline"
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
        {t("customMetrics.form.save")}
      </Button>
    </>
  );

  return (
    <form id={formId} onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="custom-metric-name">
            {t("customMetrics.form.name")}
          </Label>
          <Input
            id="custom-metric-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("customMetrics.form.namePlaceholder")}
            maxLength={120}
            autoFocus
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="custom-metric-unit">
            {t("customMetrics.form.unit")}
          </Label>
          <Input
            id="custom-metric-unit"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            placeholder={t("customMetrics.form.unitPlaceholder")}
            maxLength={40}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="custom-metric-decimals">
            {t("customMetrics.form.decimals")}
          </Label>
          <Input
            id="custom-metric-decimals"
            inputMode="numeric"
            value={decimals}
            onChange={(e) => setDecimals(e.target.value)}
            placeholder={t("customMetrics.form.decimalsPlaceholder")}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="custom-metric-low">
            {t("customMetrics.form.targetLow")}
          </Label>
          <Input
            id="custom-metric-low"
            inputMode="decimal"
            value={low}
            onChange={(e) => setLow(e.target.value)}
            placeholder={t("customMetrics.form.targetLowPlaceholder")}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="custom-metric-high">
            {t("customMetrics.form.targetHigh")}
          </Label>
          <Input
            id="custom-metric-high"
            inputMode="decimal"
            value={high}
            onChange={(e) => setHigh(e.target.value)}
            placeholder={t("customMetrics.form.targetHighPlaceholder")}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="custom-metric-description">
            {t("customMetrics.form.description")}
          </Label>
          <Textarea
            id="custom-metric-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("customMetrics.form.descriptionPlaceholder")}
            maxLength={DESCRIPTION_MAX_LENGTH}
            rows={2}
          />
        </div>
        <div className="flex items-start justify-between gap-4 sm:col-span-2">
          <div className="space-y-1">
            <Label htmlFor="custom-metric-correlation-enabled">
              {t("customMetrics.form.correlationEnabled")}
            </Label>
            <p className="text-muted-foreground text-xs">
              {t("customMetrics.form.correlationEnabledHint")}
            </p>
          </div>
          <Switch
            id="custom-metric-correlation-enabled"
            checked={correlationEnabled}
            onCheckedChange={setCorrelationEnabled}
          />
        </div>
      </div>

      <p className="text-muted-foreground text-xs">
        {t("customMetrics.form.targetHint")}
      </p>

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
