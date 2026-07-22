"use client";

import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { apiPost, apiPut } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import {
  BIOMARKER_CATALOG,
  BIOMARKER_PANELS,
} from "@/lib/labs/biomarker-catalog";
import { useTranslations } from "@/lib/i18n/context";

import type { BiomarkerDto } from "./types";

const CONTEXT_MAX_LENGTH = 2000;

/** Parse a free-text decimal that may use a comma separator. */
function parseDecimal(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

interface BiomarkerFormProps {
  /** When set the form edits this marker; otherwise it defines a new one. */
  existing?: BiomarkerDto;
  onSuccess?: (saved: BiomarkerDto) => void;
  onCancel?: () => void;
  /**
   * When mounted inside a `<ResponsiveSheet>` the caller passes the sheet's
   * footer slot element here; the Cancel / Save row portals into it so the
   * bottom-sheet branch can sticky-pin it. The Save button stays tied to the
   * `<form>` via the HTML `form` attribute.
   */
  footerSlot?: HTMLElement | null;
}

/**
 * v1.18.1 — define or edit a Biomarker catalog entry.
 *
 * A marker is the Labs feature's reusable definition: name, unit, reference
 * bounds (set ONCE, never re-entered per reading), and an optional context
 * note. When defining a new marker the user can seed the fields from the
 * common-panel catalog (a `<Select>` grouped by panel) or fill them by hand.
 * Either bound is optional (a marker may report only an upper bound, e.g.
 * LDL < 116).
 */
export function BiomarkerForm({
  existing,
  onSuccess,
  onCancel,
  footerSlot,
}: BiomarkerFormProps) {
  const { t } = useTranslations();
  const formId = useId();

  const [name, setName] = useState(existing?.name ?? "");
  const [unit, setUnit] = useState(existing?.unit ?? "");
  const [lower, setLower] = useState(
    existing?.lowerBound != null ? String(existing.lowerBound) : "",
  );
  const [upper, setUpper] = useState(
    existing?.upperBound != null ? String(existing.upperBound) : "",
  );
  const [panel, setPanel] = useState(existing?.panel ?? "");
  const [context, setContext] = useState(existing?.context ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function applySeed(slug: string) {
    const seed = BIOMARKER_CATALOG.find((s) => s.slug === slug);
    if (!seed) return;
    setName(t(`labs.catalog.${seed.slug}`));
    setUnit(seed.unit);
    setLower(seed.lowerBound != null ? String(seed.lowerBound) : "");
    setUpper(seed.upperBound != null ? String(seed.upperBound) : "");
    setPanel(t(`labs.catalog.panel.${seed.panel}`));
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!name.trim() || !unit.trim()) {
      setError(t("labs.biomarker.form.requiredError"));
      return;
    }

    const low = parseDecimal(lower);
    const high = parseDecimal(upper);
    if (low !== null && high !== null && low > high) {
      setError(t("labs.biomarker.form.rangeOrderError"));
      return;
    }

    const body = {
      name: name.trim(),
      unit: unit.trim(),
      ...(low !== null ? { lowerBound: low } : {}),
      ...(high !== null ? { upperBound: high } : {}),
      ...(panel.trim() ? { panel: panel.trim() } : {}),
      ...(context.trim() ? { context: context.trim() } : {}),
    };

    setSubmitting(true);
    try {
      const saved = existing
        ? await apiPut<BiomarkerDto>(`/api/biomarkers/${existing.id}`, body)
        : await apiPost<BiomarkerDto>("/api/biomarkers", body);
      toast.success(
        existing
          ? t("labs.biomarker.form.updatedToast")
          : t("labs.biomarker.form.savedToast"),
      );
      onSuccess?.(saved);
    } catch (err) {
      setError(localizedApiError(err, t, "labs.biomarker.form.saveError"));
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
        {t("labs.biomarker.form.save")}
      </Button>
    </>
  );

  return (
    <form id={formId} onSubmit={handleSubmit} className="space-y-4">
      {!existing ? (
        <div className="space-y-1.5">
          <Label htmlFor="biomarker-seed">
            {t("labs.biomarker.form.seedLabel")}
          </Label>
          <Select onValueChange={applySeed}>
            <SelectTrigger id="biomarker-seed" className="w-full">
              <SelectValue
                placeholder={t("labs.biomarker.form.seedPlaceholder")}
              />
            </SelectTrigger>
            <SelectContent>
              {BIOMARKER_PANELS.map((panelKey) => {
                const items = BIOMARKER_CATALOG.filter(
                  (s) => s.panel === panelKey,
                );
                if (items.length === 0) return null;
                return (
                  <SelectGroup key={panelKey}>
                    <SelectLabel>
                      {t(`labs.catalog.panel.${panelKey}`)}
                    </SelectLabel>
                    {items.map((s) => (
                      <SelectItem key={s.slug} value={s.slug}>
                        {t(`labs.catalog.${s.slug}`)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                );
              })}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">
            {t("labs.biomarker.form.seedHint")}
          </p>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="biomarker-name">
            {t("labs.biomarker.form.name")}
          </Label>
          <Input
            id="biomarker-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("labs.biomarker.form.namePlaceholder")}
            maxLength={120}
            autoFocus
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="biomarker-unit">
            {t("labs.biomarker.form.unit")}
          </Label>
          <Input
            id="biomarker-unit"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            placeholder={t("labs.biomarker.form.unitPlaceholder")}
            maxLength={40}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="biomarker-panel">
            {t("labs.biomarker.form.panel")}
          </Label>
          <Input
            id="biomarker-panel"
            value={panel}
            onChange={(e) => setPanel(e.target.value)}
            placeholder={t("labs.biomarker.form.panelPlaceholder")}
            maxLength={120}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="biomarker-lower">
            {t("labs.biomarker.form.lowerBound")}
          </Label>
          <Input
            id="biomarker-lower"
            inputMode="decimal"
            value={lower}
            onChange={(e) => setLower(e.target.value)}
            placeholder={t("labs.biomarker.form.lowerPlaceholder")}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="biomarker-upper">
            {t("labs.biomarker.form.upperBound")}
          </Label>
          <Input
            id="biomarker-upper"
            inputMode="decimal"
            value={upper}
            onChange={(e) => setUpper(e.target.value)}
            placeholder={t("labs.biomarker.form.upperPlaceholder")}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="biomarker-context">
            {t("labs.biomarker.form.context")}
          </Label>
          <Textarea
            id="biomarker-context"
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder={t("labs.biomarker.form.contextPlaceholder")}
            maxLength={CONTEXT_MAX_LENGTH}
            rows={2}
          />
        </div>
      </div>

      <p className="text-muted-foreground text-xs">
        {t("labs.biomarker.form.rangeHint")}
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
