/**
 * `POST /api/tokens/documents` — mint a Bearer that can upload documents into
 * the vault and do nothing else (#1038).
 *
 * The door another document system pushes through: a Paperless-ngx workflow
 * posting a newly tagged document, or the import script copying an archive
 * across. It is the measurement-ingest mint (`../measurements/route.ts`)
 * copied for a second scope, and every argument made there holds here — read
 * that file for the reasoning behind each guard. In short:
 *
 * - `permissions` is a literal, so no request shape reaches it;
 * - `documents:write` is accepted by exactly one route, the upload, on the
 *   holder's own record, and the answer it gets back is a receipt rather than
 *   the stored row — it cannot list, read, download, edit or delete a
 *   document, reach the AI legs, or mint another token;
 * - minting takes a cookie session, because a short-lived native access token
 *   must not be able to leave behind a credential that lives a year;
 * - ten mints a minute and ten live tokens bound a runaway loop.
 *
 * No listing and no revoke of its own: `GET /api/tokens` lists every token
 * with its permissions and `DELETE /api/tokens/[id]` revokes one.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireCookieAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { issueApiToken } from "@/lib/auth/issue-token";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { checkRateLimit } from "@/lib/rate-limit";
import { DOCUMENTS_WRITE_SCOPE } from "@/lib/documents/scopes";
import { createDocumentTokenSchema } from "@/lib/validations/tokens";

/**
 * Days a token lives when the caller names no lifetime. A year, like the
 * measurement token: it is pasted into a workflow that runs unattended, where
 * a quiet expiry surfaces as "new letters stopped arriving in the spring".
 */
const DEFAULT_EXPIRY_DAYS = 365;

/** Mints per user per minute. */
const MINT_RATE_LIMIT_MAX = 10;
const MINT_RATE_LIMIT_WINDOW_MS = 60 * 1000;

/** Live document tokens an account may hold at once; catches a loop. */
const MAX_LIVE_TOKENS = 10;

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireCookieAuth();
  annotate({ action: { name: "tokens.documents.create" } });

  if (!(await isApiGloballyEnabled())) {
    return apiError("API is globally disabled", 403);
  }

  const rl = await checkRateLimit(
    `tokens:documents:mint:${user.id}`,
    MINT_RATE_LIMIT_MAX,
    MINT_RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many token mints, try again later", 429);
  }

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 16 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = createDocumentTokenSchema.safeParse(body);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422);
  }

  // Counted live and per scope, after validation and before the create; the
  // count-then-create race is bounded by the mint bucket above. See the
  // measurement mint for the full argument.
  const live = await prisma.apiToken.count({
    where: {
      userId: user.id,
      revoked: false,
      permissions: { has: DOCUMENTS_WRITE_SCOPE },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });
  if (live >= MAX_LIVE_TOKENS) {
    annotate({
      action: { name: "tokens.documents.create" },
      meta: { outcome: "ceiling_reached", live_token_count: live },
    });
    return apiError(
      `You already have ${MAX_LIVE_TOKENS} document tokens. Revoke one before creating another.`,
      409,
      { errorCode: "tokens.documents.ceiling_reached" },
    );
  }

  const issued = await issueApiToken({
    userId: user.id,
    name: parsed.data.name,
    // A literal, never spread and never derived from the body. `issueApiToken`
    // defaults to `["*"]` when this property is absent, which is why the unit
    // suite asserts this array and not merely the 201.
    permissions: [DOCUMENTS_WRITE_SCOPE],
    expiresInDays: parsed.data.expiresInDays ?? DEFAULT_EXPIRY_DAYS,
  });

  await auditLog("tokens.documents.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { tokenId: issued.tokenId, scope: DOCUMENTS_WRITE_SCOPE },
  });

  // The raw token, once. It is stored as an HMAC and no path re-reveals it.
  return apiSuccess(
    { token: issued.token, name: issued.name, expiresAt: issued.expiresAt },
    201,
  );
});
