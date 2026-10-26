/**
 * Document picker (#1038): save or remove the person's connection to one
 * document archive (`paperless` or `papra`).
 *
 * PUT validates the base address against the operator's list
 * (`DOCUMENT_SOURCE_ORIGINS`), tests the connection live before storing
 * anything (a wrong token or an unreachable host is reported here, not on the
 * first search), then stores the token encrypted. A PUT without a token keeps
 * the stored one, so the base path or the Papra organization can change
 * without typing the key again, but only on the same origin: a new origin, and
 * the first save, must carry it (422 `documents.sources.tokenRequired`). The response is the
 * connection without its token, like every read of it.
 *
 * DELETE removes the row, and with it the token.
 *
 * Cookie-only and owner-only; see `admitDocumentSourceCaller`.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { decrypt, encrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { sourceClient } from "@/lib/documents/sources/clients";
import {
  loadConnection,
  toConnectionDto,
} from "@/lib/documents/sources/connections";
import { DocumentSourceError } from "@/lib/documents/sources/http";
import { evaluateSourceBaseUrl } from "@/lib/documents/sources/origins";
import {
  admitDocumentSourceCaller,
  checkConnectRateLimit,
  responseForSourceFailure,
  sourceErrorResponse,
  systemParam,
} from "@/lib/documents/sources/route-support";
import { annotate } from "@/lib/logging/context";
import { rateLimitHeaders } from "@/lib/rate-limit";
import { documentSourceSaveSchema } from "@/lib/validations/document-sources";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ system: string }> };

export const PUT = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const auth = await requireAuth();
    const refused = await admitDocumentSourceCaller(auth);
    if (refused) return refused;
    const system = await systemParam(params);
    if (system instanceof Response) return system;
    const userId = auth.user.id;
    annotate({ action: { name: "documents.sources.save" }, meta: { system } });

    const rl = await checkConnectRateLimit(userId);
    if (!rl.allowed) {
      return sourceErrorResponse(
        "rateLimited",
        undefined,
        rateLimitHeaders(rl),
      );
    }

    const parsed = await parseJsonBody(request, documentSourceSaveSchema, {
      maxBytes: 8 * 1024,
      message: "Invalid connection details",
    });
    if (!parsed.ok) return parsed.error;

    const verdict = evaluateSourceBaseUrl(parsed.data.baseUrl);
    if (!verdict.ok) {
      return verdict.reason === "notAllowed"
        ? sourceErrorResponse("originNotAllowed")
        : apiError("Enter the full address, starting with https://.", 422, {
            errorCode: "documents.sources.invalidAddress",
          });
    }

    const organizationId =
      system === "PAPRA" ? (parsed.data.organizationId ?? null) : null;
    if (system === "PAPRA" && !organizationId) {
      return apiError("Papra needs the organization id.", 422, {
        errorCode: "documents.sources.organizationRequired",
      });
    }

    const existing = await loadConnection(userId, system);
    // The stored token is only ever sent back to the origin it was saved
    // for. A new address on another origin needs the token typed again, or
    // saving an address would hand the old archive's token to whatever the
    // new one is.
    const reusable =
      existing !== null &&
      evaluateSourceBaseUrl(existing.baseUrl, new Set([verdict.origin])).ok;
    const token =
      parsed.data.token ??
      (existing && reusable ? decrypt(existing.tokenEncrypted) : null);
    if (!token) {
      return apiError("Enter the API token.", 422, {
        errorCode: "documents.sources.tokenRequired",
      });
    }

    // Live check before anything is stored: the row only ever holds a
    // connection that answered once.
    try {
      await sourceClient({
        system,
        origin: verdict.origin,
        baseUrl: verdict.baseUrl,
        organizationId,
        token,
      }).test();
    } catch (err) {
      if (err instanceof DocumentSourceError) {
        annotate({ meta: { refused: err.code } });
      }
      return responseForSourceFailure(err);
    }

    const now = new Date();
    const tokenEncrypted = encrypt(token);
    // Field by field; `userId` from the session, never the body.
    const saved = await prisma.documentSourceConnection.upsert({
      where: { userId_system: { userId, system } },
      create: {
        userId,
        system,
        baseUrl: verdict.baseUrl,
        organizationId,
        tokenEncrypted,
        lastVerifiedAt: now,
      },
      update: {
        baseUrl: verdict.baseUrl,
        organizationId,
        tokenEncrypted,
        lastVerifiedAt: now,
      },
      select: {
        system: true,
        baseUrl: true,
        organizationId: true,
        lastVerifiedAt: true,
      },
    });

    await auditLog("documents.sources.connect", {
      userId,
      ipAddress: getClientIp(request),
      details: { system, origin: verdict.origin, replaced: existing !== null },
    });

    return apiSuccess(toConnectionDto(saved));
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const auth = await requireAuth();
    // Neither the list nor the module is needed to forget a connection: an
    // operator who removed the origin, or a person who switched Documents
    // off, must still be able to delete the stored token.
    const refused = await admitDocumentSourceCaller(auth, {
      needsList: false,
      needsModule: false,
    });
    if (refused) return refused;
    const system = await systemParam(params);
    if (system instanceof Response) return system;
    annotate({
      action: { name: "documents.sources.disconnect" },
      meta: { system },
    });

    const { count } = await prisma.documentSourceConnection.deleteMany({
      where: { userId: auth.user.id, system },
    });
    if (count > 0) {
      await auditLog("documents.sources.disconnect", {
        userId: auth.user.id,
        ipAddress: getClientIp(request),
        details: { system },
      });
    }
    return apiSuccess({ disconnected: count > 0 });
  },
);
