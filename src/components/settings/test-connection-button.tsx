"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, Plug, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import { translateCode } from "@/lib/i18n/translate-code";

/**
 * Shared "Test connection" UX for the settings integrations + notifications
 * sections (A8-UI). POSTs to the given endpoint, expects a `{ data, error,
 * meta }` envelope, and surfaces success (latency) or a translated
 * `meta.errorCode` callout. When the route reports what the other end
 * answered (`meta.upstreamStatus` / `meta.smtpCode` / `meta.upstreamBody`,
 * the notification test routes since #947), the callout shows the status and
 * the relay's own words beneath it, as plain text.
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
  /**
   * The card's form differs from what is saved. The test route sends through
   * the saved config, so the button waits for a save and says so instead of
   * testing something other than what is on screen.
   */
  unsavedChanges?: boolean;
}

interface TestResponse {
  data?: { latencyMs?: number; ok?: boolean; sent?: number };
  error?: string;
  meta?: {
    errorCode?: string;
    upstreamStatus?: number;
    smtpCode?: number;
    upstreamBody?: string;
  };
}

export interface TestConnectionFailureProps {
  /** The translated error sentence. */
  message: string;
  upstreamStatus?: number;
  smtpCode?: number;
  /** What the other end answered, already bounded and cleaned by the server. */
  upstreamBody?: string;
}

/**
 * The failure callout. Hook-free so it renders without a provider. The
 * relay's body is a React text child, never markup: whatever it contains is
 * shown as characters.
 */
export function TestConnectionFailure({
  message,
  upstreamStatus,
  smtpCode,
  upstreamBody,
}: TestConnectionFailureProps) {
  const code =
    typeof upstreamStatus === "number"
      ? ` (HTTP ${upstreamStatus})`
      : typeof smtpCode === "number"
        ? ` (SMTP ${smtpCode})`
        : "";
  return (
    <div role="alert" className="space-y-1">
      <p className="text-destructive flex items-center gap-1.5 text-sm">
        <XCircle className="size-3.5 shrink-0" />
        {`${message}${code}`}
      </p>
      {upstreamBody ? (
        <p
          data-testid="test-connection-upstream-body"
          className="text-foreground font-mono text-xs break-all"
        >
          {upstreamBody}
        </p>
      ) : null}
    </div>
  );
}

export type ConnectionTestResult =
  | { kind: "ok"; latency: number }
  | {
      kind: "error";
      errorCode: string;
      upstreamStatus?: number;
      smtpCode?: number;
      upstreamBody?: string;
    };

/**
 * The button's probe: POST the endpoint and read the envelope into what the
 * button shows. Exported so the reading of a real failure response can be
 * tested without a DOM.
 */
export async function runConnectionTest(
  endpoint: string,
): Promise<ConnectionTestResult> {
  try {
    const res = await apiFetchRaw(endpoint, { method: "POST" });
    const json = (await res.json().catch(() => ({}))) as TestResponse;

    if (res.ok && json.data?.ok !== false) {
      return { kind: "ok", latency: json.data?.latencyMs ?? 0 };
    }
    const meta = json.meta;
    return {
      kind: "error",
      errorCode: meta?.errorCode ?? "generic",
      upstreamStatus:
        typeof meta?.upstreamStatus === "number"
          ? meta.upstreamStatus
          : undefined,
      smtpCode: typeof meta?.smtpCode === "number" ? meta.smtpCode : undefined,
      upstreamBody:
        typeof meta?.upstreamBody === "string" ? meta.upstreamBody : undefined,
    };
  } catch {
    return { kind: "error", errorCode: "connection_failed" };
  }
}

export function TestConnectionButton({
  endpoint,
  disabled = false,
  label,
  unsavedChanges = false,
}: TestConnectionButtonProps) {
  const { t } = useTranslations();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ConnectionTestResult | null>(null);

  async function handleClick() {
    setTesting(true);
    setResult(null);
    try {
      setResult(await runConnectionTest(endpoint));
    } finally {
      setTesting(false);
    }
  }

  function describeError(errorCode: string): string {
    return translateCode(
      t,
      "settings.testConnection.errors",
      errorCode,
      "settings.testConnection.errors.generic",
    );
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleClick}
        disabled={disabled || testing || unsavedChanges}
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

      {unsavedChanges && (
        <p
          data-slot="test-connection-save-first"
          className="text-muted-foreground text-xs"
        >
          {t("settings.testConnection.saveFirst")}
        </p>
      )}

      {!unsavedChanges && result?.kind === "ok" && (
        <p
          role="status"
          className="text-success flex items-center gap-1.5 text-xs"
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          {t("settings.testConnection.ok", { latency: result.latency })}
        </p>
      )}

      {!unsavedChanges && result?.kind === "error" && (
        <TestConnectionFailure
          message={describeError(result.errorCode)}
          upstreamStatus={result.upstreamStatus}
          smtpCode={result.smtpCode}
          upstreamBody={result.upstreamBody}
        />
      )}
    </div>
  );
}
