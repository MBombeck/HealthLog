"use client";

import { useState } from "react";
import { Copy, CheckCircle2, RotateCcw, Bug } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { useAppSettings } from "@/components/app-settings-provider";

export interface ErrorDetailsProps {
  /** The error object, whether it's a runtime Error or a typed API error. */
  error: Error & { digest?: string };
  /** Pass Next.js' `reset()` callback if available. */
  reset?: () => void;
  /** Request ID propagated from the server (x-request-id), if known. */
  requestId?: string | null;
  /** Extra fields to include in the diagnostic payload. */
  context?: Record<string, unknown>;
  /** Override the "Report bug" link target. */
  reportHref?: string;
}

/**
 * Structured error panel with a copy-to-clipboard payload that includes
 * everything we'd need to reproduce or file an issue: message, stack digest,
 * URL, user agent, locale, timestamp.
 */
export function ErrorDetails({
  error,
  reset,
  requestId,
  context,
  reportHref = "/bugreport",
}: ErrorDetailsProps) {
  const { t, locale } = useTranslations();
  const { bugReportEnabled } = useAppSettings();
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    // Only capture the pathname — some flows carry OAuth codes / state tokens
    // in the query string (Withings connect, password reset) and we don't
    // want users pasting those into public GitHub issues. Preserve the count
    // for context without exposing values.
    const loc = typeof window !== "undefined" ? window.location : null;
    const urlPath = loc?.pathname ?? null;
    const searchParamCount = loc?.search
      ? new URLSearchParams(loc.search).toString().split("&").filter(Boolean)
          .length
      : 0;

    const payload = {
      message: error.message,
      digest: error.digest,
      name: error.name,
      stack: error.stack?.split("\n").slice(0, 10).join("\n"),
      requestId: requestId ?? null,
      urlPath,
      searchParamCount,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
      locale,
      timestamp: new Date().toISOString(),
      context,
    };

    const text = JSON.stringify(payload, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: open a prompt the user can copy from manually.
      window.prompt(t("common.copyDetails"), text);
    }
  }

  return (
    // v1.4.27 MB6 — `min-h-dvh flex flex-col justify-center` makes
    // the error panel anchor in the middle of the available viewport
    // even when this component is mounted at the root layout. Without
    // it the panel hugged the top edge under the notch on
    // small-screen devices.
    <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center space-y-4 p-6">
      <h1 className="text-xl font-semibold">{t("errorBoundary.title")}</h1>
      <p className="text-muted-foreground text-sm">
        {t("errorBoundary.description")}
      </p>
      <div className="bg-muted/50 text-muted-foreground rounded-md border p-3 font-mono text-xs break-all">
        {error.message || t("common.unknownError")}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {reset && (
          <Button onClick={reset} variant="outline">
            <RotateCcw className="mr-2 h-4 w-4" />
            {t("common.retry")}
          </Button>
        )}
        <Button onClick={handleCopy} variant="outline">
          {copied ? (
            <CheckCircle2 className="text-dracula-green mr-2 h-4 w-4" />
          ) : (
            <Copy className="mr-2 h-4 w-4" />
          )}
          {copied ? t("common.copied") : t("common.copyDetails")}
        </Button>
        {bugReportEnabled && (
          <Button asChild variant="outline">
            <Link href={reportHref}>
              <Bug className="mr-2 h-4 w-4" />
              {t("common.reportIssue")}
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}
