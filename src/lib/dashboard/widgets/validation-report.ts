/**
 * The wide-event line a refused dashboard-layout save leaves behind.
 *
 * Every issue is surfaced (iOS contract debugging used to take one round
 * trip per wrong field), next to the shape of the payload the client sent,
 * so a single line carries enough detail to diagnose serialiser drift in the
 * native client. Only the top-level keys plus a hard 256-char JSON excerpt
 * are logged — never the full body — so PII / token-like fields cannot leak.
 * The diagnostic shape is built by the shared `buildPayloadDiagnostic`
 * helper so the widget and series routes can't drift; the body is routed
 * through `redactForExcerpt` first so any field matching the denylist
 * (password / token / secret / apiKey / authorization / csrfState / nonce)
 * lands as the literal `"[redacted]"` instead of its raw value.
 */
import type { z } from "zod/v4";

import { buildPayloadDiagnostic, sanitiseZodIssues } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { redactForExcerpt } from "@/lib/observability/redact-payload";

export function reportLayoutValidationFailure(
  body: unknown,
  error: z.ZodError,
): void {
  const issues = sanitiseZodIssues(error.issues);
  const payloadDiagnostic = buildPayloadDiagnostic(redactForExcerpt(body));
  annotate({
    action: { name: "dashboard.widgets.validation-failed" },
    meta: {
      issue_count: issues.length,
      ...payloadDiagnostic,
      zod_issues: issues,
    },
  });
}
