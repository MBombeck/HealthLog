"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, Plug, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { apiFetchRaw } from "@/lib/api/api-fetch";

/**
 * Shared "Test connection" UX for the settings integrations + notifications
 * sections (A8-UI). POSTs to the given endpoint, expects a `{ data, error,
 * meta }` envelope, and surfaces success (latency) or a translated
 * `meta.errorCode` callout.
 *
 * Endpoints are user-scoped, so the button intentionally does NOT send an
 * Idempotency-Key — each click probes the upstream live.
 */
export interface TestConnectionButtonProps {
  endpoint: string;
  /** Optional disabled flag from the parent — typically "no credentials yet". */
  disabled?: boolean;
  /** Label override for the button (defaults to settings.testConnection.test). */
  label?: string;
}

interface TestResponse {
  data?: { latencyMs?: number; ok?: boolean; sent?: number };
  error?: string;
  meta?: { errorCode?: string };
}

export function TestConnectionButton({
  endpoint,
  disabled = false,
  label,
}: TestConnectionButtonProps) {
  const { t } = useTranslations();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<
    | { kind: "ok"; latency: number }
    | { kind: "error"; errorCode: string }
    | null
  >(null);

  async function handleClick() {
    setTesting(true);
    setResult(null);
    try {
      const res = await apiFetchRaw(endpoint, { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as TestResponse;

      if (res.ok && json.data?.ok !== false) {
        setResult({
          kind: "ok",
          latency: json.data?.latencyMs ?? 0,
        });
      } else {
        setResult({
          kind: "error",
          errorCode: json.meta?.errorCode ?? "generic",
        });
      }
    } catch {
      setResult({ kind: "error", errorCode: "connection_failed" });
    } finally {
      setTesting(false);
    }
  }

  function describeError(errorCode: string): string {
    const key = `settings.testConnection.errors.${errorCode}`;
    const translated = t(key);
    // `t()` returns the raw key when missing — fall back to generic.
    if (translated === key) {
      return t("settings.testConnection.errors.generic");
    }
    return translated;
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="min-h-11"
        onClick={handleClick}
        disabled={disabled || testing}
      >
        {testing ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
        ) : (
          <Plug className="h-3.5 w-3.5" />
        )}
        {testing
          ? t("settings.testConnection.testing")
          : (label ?? t("settings.testConnection.test"))}
      </Button>

      {result?.kind === "ok" && (
        <p
          role="status"
          className="text-success flex items-center gap-1.5 text-xs"
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          {t("settings.testConnection.ok", { latency: result.latency })}
        </p>
      )}

      {result?.kind === "error" && (
        <p
          role="alert"
          className="text-destructive flex items-center gap-1.5 text-sm"
        >
          <XCircle className="h-3.5 w-3.5" />
          {describeError(result.errorCode)}
        </p>
      )}
    </div>
  );
}
