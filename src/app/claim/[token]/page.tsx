import { redirect } from "next/navigation";

import { looksLikeHandoverToken } from "@/lib/auth/handover-token";

/**
 * v1.42 (#959) — the managed-profile handover link landing.
 *
 * `https://<host>/claim/<hlp_token>` is the link a Guardian hands over. The
 * proxy answers it at the edge with a 307 onto `/auth/claim?token=…`
 * (`src/proxy.ts`), so in practice this page never renders; it stays as the
 * fallback for any path that bypasses the proxy matcher, exactly like
 * `src/app/invite/[token]/page.tsx`.
 *
 * Security, the invite landing's posture:
 *   - the `hlp_` shape is validated before the token is reflected into the
 *     redirect target, so a malformed segment lands on the bare claim page
 *     and the page never echoes attacker-controlled text;
 *   - no database read: a well-formed unknown token and a valid one redirect
 *     identically. Whether a token is real is only decided by the anonymous
 *     preview and claim routes, behind their uniform 404 and rate limit;
 *   - the token is never logged here (and `/claim/` is a registered secret
 *     path in `src/lib/logging/redact.ts`).
 */
export default async function ClaimLandingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (looksLikeHandoverToken(token)) {
    redirect(`/auth/claim?token=${encodeURIComponent(token)}`);
  }
  redirect("/auth/claim");
}
