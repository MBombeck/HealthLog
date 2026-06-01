"use client";

/**
 * v1.5.0 — NaturalLanguageExtractor overlay.
 *
 * Step 1 of the medication-create wizard ships a "Describe it" button
 * that opens this dialog. The user types a free-text description
 * ("Mounjaro 5mg weekly Wednesday morning starting next Monday"); the
 * route at /api/medications/extract returns a structured partial
 * payload; the dialog calls `onPrefill(...)` and closes so the wizard
 * pre-fills its steps.
 *
 * Mobile-first contract:
 *   - 44 px tap-target floor on every interactive control (WCAG 2.5.5).
 *   - `aria-busy` toggles on the dialog body while the request is in
 *     flight so assistive tech announces the wait state.
 *   - `motion-reduce:animate-none` on the loader so `prefers-reduced-
 *     motion` callers get a static glyph.
 *
 * i18n keys consumed (namespace `medications.scheduling.naturalLanguage.*`):
 *
 *   .title            — dialog headline
 *   .description      — short prompt under the headline
 *   .placeholder      — textarea placeholder
 *   .examples.label   — "Try one of these examples:"
 *   .examples.weekly  — "Mounjaro 5mg weekly Wednesday morning"
 *   .examples.daily   — "Ibuprofen 200mg every day, 3 times a day"
 *   .examples.rolling — "Methotrexate 7.5mg every 7 days from last injection"
 *   .submit           — "Extract"
 *   .submitBusy       — "Extracting…"
 *   .cancel           — "Cancel"
 *   .error.network    — "Could not reach the AI provider — please retry"
 *   .error.empty      — "Type a description first"
 *   .error.tooLong    — "Keep the description under 2000 characters"
 *   .error.rateLimit  — "Too many requests — wait a moment and try again"
 *   .error.noProvider — "No AI provider configured — set one up in Settings"
 *   .error.budget     — "Daily AI budget reached — try again tomorrow"
 *
 * The wizard component owns the rendering of the trigger button — this
 * file only owns the dialog body so the wizard's "✨ Beschreiben"
 * button is the open-trigger.
 */

import { useCallback, useId, useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useTranslations } from "@/lib/i18n/context";

import type { MedicationExtractionResult } from "@/lib/ai/coach/medication-extract-prompt";

/**
 * The wizard accepts the same partial shape the route returns.
 * Exposed as a named alias so the wizard layer can import a single
 * type and the prompt-side definition stays the source of truth.
 */
export type WizardPayload = MedicationExtractionResult;

export interface NaturalLanguageExtractorProps {
  /** Controlled open/closed state — the wizard owns it. */
  open: boolean;
  /** Fired when the dialog should close (user dismiss, success). */
  onClose: () => void;
  /** Fired on a successful extraction; the wizard merges + closes. */
  onPrefill: (partial: Partial<WizardPayload>) => void;
  /**
   * UI locale forwarded to the route as a hint. The route accepts an
   * undefined value and falls back to the resolver chain.
   */
  locale?: "en" | "de" | "es" | "fr" | "it" | "pl";
  /**
   * Optional override of the API path so the wizard test harness can
   * point at a mock server. Defaults to the production route.
   */
  endpoint?: string;
}

type DialogError =
  | { kind: "empty" }
  | { kind: "tooLong" }
  | { kind: "rateLimit" }
  | { kind: "noProvider" }
  | { kind: "budget" }
  | { kind: "network"; message?: string };

const MAX_TEXT_LENGTH = 2000;

export function NaturalLanguageExtractor({
  open,
  onClose,
  onPrefill,
  locale,
  endpoint = "/api/medications/extract",
}: NaturalLanguageExtractorProps) {
  const { t } = useTranslations();
  const textareaId = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DialogError | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    setText("");
    setError(null);
    setBusy(false);
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  const handleSubmit = useCallback(async () => {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      setError({ kind: "empty" });
      return;
    }
    if (trimmed.length > MAX_TEXT_LENGTH) {
      setError({ kind: "tooLong" });
      return;
    }

    setError(null);
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed, locale }),
        signal: controller.signal,
      });

      if (res.status === 429) {
        setError({ kind: "rateLimit" });
        return;
      }
      if (res.status === 503) {
        setError({ kind: "noProvider" });
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        if (
          body?.error &&
          /budget/i.test(body.error)
        ) {
          setError({ kind: "budget" });
          return;
        }
        setError({ kind: "network", message: body?.error });
        return;
      }

      const body = (await res.json()) as {
        data: Partial<WizardPayload> | null;
        error: string | null;
      };
      if (body.error || !body.data) {
        setError({ kind: "network", message: body.error ?? undefined });
        return;
      }
      onPrefill(body.data);
      reset();
      onClose();
    } catch (err) {
      if (
        err instanceof DOMException &&
        (err.name === "AbortError" || err.name === "TimeoutError")
      ) {
        // Caller dismissed the dialog mid-flight; do not surface.
        return;
      }
      setError({
        kind: "network",
        message: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [endpoint, locale, onClose, onPrefill, reset, text]);

  const insertExample = useCallback((example: string) => {
    setText(example);
    setError(null);
  }, []);

  const errorMessage = error ? resolveErrorMessage(error, t) : null;
  const charCount = text.length;
  const overLimit = charCount > MAX_TEXT_LENGTH;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleClose();
      }}
    >
      <DialogContent aria-busy={busy || undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4" aria-hidden="true" />
            {t("medications.scheduling.naturalLanguage.title")}
          </DialogTitle>
          <DialogDescription>
            {t("medications.scheduling.naturalLanguage.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div>
            <Label htmlFor={textareaId} className="sr-only">
              {t("medications.scheduling.naturalLanguage.title")}
            </Label>
            <Textarea
              id={textareaId}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                if (error) setError(null);
              }}
              placeholder={t(
                "medications.scheduling.naturalLanguage.placeholder",
              )}
              rows={4}
              maxLength={MAX_TEXT_LENGTH + 200}
              disabled={busy}
              aria-invalid={overLimit || error?.kind === "empty" || undefined}
              aria-describedby={errorMessage ? `${textareaId}-error` : undefined}
            />
            <div className="mt-1 text-right text-xs text-muted-foreground">
              {charCount} / {MAX_TEXT_LENGTH}
            </div>
          </div>

          {errorMessage ? (
            <p
              id={`${textareaId}-error`}
              role="alert"
              className="text-sm text-destructive"
            >
              {errorMessage}
            </p>
          ) : null}

          <fieldset className="flex flex-col gap-2">
            <legend className="text-xs font-medium text-muted-foreground">
              {t("medications.scheduling.naturalLanguage.examples.label")}
            </legend>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <ExampleChip
                onPick={insertExample}
                label={t(
                  "medications.scheduling.naturalLanguage.examples.weekly",
                )}
                disabled={busy}
              />
              <ExampleChip
                onPick={insertExample}
                label={t(
                  "medications.scheduling.naturalLanguage.examples.daily",
                )}
                disabled={busy}
              />
              <ExampleChip
                onPick={insertExample}
                label={t(
                  "medications.scheduling.naturalLanguage.examples.rolling",
                )}
                disabled={busy}
              />
            </div>
          </fieldset>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            disabled={busy}
            className="min-h-11 sm:min-h-9"
          >
            {t("medications.scheduling.naturalLanguage.cancel")}
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={busy || overLimit}
            aria-busy={busy || undefined}
            className="min-h-11 sm:min-h-9"
          >
            {busy ? (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <Sparkles className="size-4" aria-hidden="true" />
            )}
            {busy
              ? t("medications.scheduling.naturalLanguage.submitBusy")
              : t("medications.scheduling.naturalLanguage.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ExampleChipProps {
  label: string;
  onPick: (text: string) => void;
  disabled?: boolean;
}

function ExampleChip({ label, onPick, disabled }: ExampleChipProps) {
  return (
    <button
      type="button"
      onClick={() => onPick(label)}
      disabled={disabled}
      className="min-h-11 rounded-md border border-input bg-background px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 sm:min-h-9"
    >
      {label}
    </button>
  );
}

function resolveErrorMessage(
  error: DialogError,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  switch (error.kind) {
    case "empty":
      return t("medications.scheduling.naturalLanguage.error.empty");
    case "tooLong":
      return t("medications.scheduling.naturalLanguage.error.tooLong");
    case "rateLimit":
      return t("medications.scheduling.naturalLanguage.error.rateLimit");
    case "noProvider":
      return t("medications.scheduling.naturalLanguage.error.noProvider");
    case "budget":
      return t("medications.scheduling.naturalLanguage.error.budget");
    case "network":
    default:
      return t("medications.scheduling.naturalLanguage.error.network");
  }
}
