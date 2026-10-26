/**
 * /api/share-links — owner clinician-share-link lifecycle (Epic C, C4).
 *
 *   POST  → create a link. Mints an `hls_<48 hex>` token (192-bit), stores
 *           ONLY its HMAC hash, returns the raw token EXACTLY ONCE. Every
 *           scope column is frozen write-once at creation.
 *   GET   → list the caller's own links (never the raw token — it is
 *           unrecoverable after the create response).
 *
 * Auth: cookie session OR Bearer (`requireAuth`). `userId` is always narrowed
 * from the auth context; there is no `userId` body field. Rate-limited.
 * This is the OWNER lifecycle only — the public resolver / view (C3/C5) is a
 * separate surface.
 */
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";

import { apiHandler, requireAuth, requireRecentProof } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { hashToken } from "@/lib/auth/hmac";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import {
  createShareLinkSchema,
  SHARE_LINK_FORBIDDEN_LEAVES,
} from "@/lib/validations/clinician-share-link";
import {
  EMPTY_REPORT_SELECTION,
  reportSelectionSchema,
  selectionFromRequest,
  selectionToBlob,
} from "@/lib/report-selection/selection";
import {
  generatePassphrase,
  hashPassphrase,
  normalisePassphrase,
  PASSPHRASE_FRAGMENT_KEY,
} from "@/lib/clinician-share/passphrase";
import type { Prisma } from "@/generated/prisma/client";

/**
 * The absolute origin to build the public share URL from. Prefers the
 * forwarded host/proto a reverse proxy sets (the documented self-hosting path
 * fronts the app with Caddy/Traefik/Nginx), falling back to the request URL's
 * own origin. The QR payload carries the passphrase in the FRAGMENT only.
 */
function resolveOrigin(request: NextRequest): string {
  const proto =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    new URL(request.url).protocol.replace(":", "");
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host") ||
    new URL(request.url).host;
  return `${proto}://${host}`;
}

/**
 * The row selection every owner-facing projection reads. `_count.documents`
 * surfaces the size of the frozen document set without ever loading the ids
 * (let alone the blobs) — the metadata-only discipline (P3-D5).
 */
const shareLinkSummarySelect = {
  id: true,
  label: true,
  rangeStart: true,
  rangeEnd: true,
  documentOnly: true,
  // Read to answer one owner-facing question: does this link's frozen scope
  // predate the selection model? Never returned — only the boolean derived
  // from it is.
  sectionsJson: true,
  passphraseHash: true,
  expiresAt: true,
  createdAt: true,
  revokedAt: true,
  lastAccessAt: true,
  accessCount: true,
  _count: { select: { documents: true } },
} as const;

/** Project a stored row to the safe owner-facing shape (never the token). */
function toSummary(row: {
  id: string;
  label: string;
  rangeStart: Date;
  rangeEnd: Date | null;
  documentOnly: boolean;
  sectionsJson: unknown;
  passphraseHash: string | null;
  expiresAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
  lastAccessAt: Date | null;
  accessCount: number;
  _count: { documents: number };
}) {
  return {
    id: row.id,
    label: row.label,
    rangeStart: row.rangeStart.toISOString(),
    rangeEnd: row.rangeEnd ? row.rangeEnd.toISOString() : null,
    // v1.28.16 — the frozen documents-only flag (owner-facing; the serve path
    // gates on the column, not on "are all sections off?").
    documentOnly: row.documentOnly,
    // A record link whose frozen scope predates the selection model. The
    // v1.32.37 migration revoked every one of them, because their scope was
    // "everything except mood and cycle" — a scope nobody chose. The sharing
    // list surfaces this so the owner sees why the link closed and can re-mint
    // with the same label, window and expiry, stopped at the selection step.
    needsReselection:
      !row.documentOnly &&
      !reportSelectionSchema.safeParse(row.sectionsJson).success,
    // v1.18.7 — surface only WHETHER a passphrase guards the link, never the
    // hash itself. Legacy (null-hash) links read `false` and stay ungated.
    protected: row.passphraseHash !== null,
    // v1.28 — how many documents this share carries (never the ids, never the
    // bytes; the serve route is the only decrypt path).
    documentCount: row._count.documents,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    lastAccessAt: row.lastAccessAt ? row.lastAccessAt.toISOString() : null,
    accessCount: row.accessCount,
    // Status the UI can render without re-deriving expiry/revocation.
    active: row.revokedAt === null && row.expiresAt.getTime() > Date.now(),
  };
}

export const POST = apiHandler(async (request: NextRequest) => {
  // A share link is a standing credential to the record that works without
  // signing in, so making one needs a fresh proof on the cookie path, not only
  // a live session. The shipped app creates links on its token without an
  // elevation, and reads any 401 here as a dead session, so the Bearer arm
  // stays on the token until the app sends one (see the iOS note).
  const { user } = await requireRecentProof({ bearer: "token" });
  annotate({ action: { name: "share-link.create" } });

  const rl = await checkRateLimit(`share-link:${user.id}`, 20, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Maximum 20 share-link operations per hour", 429);
  }

  const parsed = await parseJsonBody(request, createShareLinkSchema, {
    maxBytes: 16 * 1024,
  });
  if (!parsed.ok) return parsed.error;
  const input = parsed.data;

  // v1.28.13 — a documents-only share carries NO report scope. Force it empty
  // here (not just at the client) so a document link can never serve a single
  // health metric, whatever the body tried to smuggle. "Share this document"
  // means the document, not the whole record.
  const documentOnly = input.documentOnly === true;

  let selection = EMPTY_REPORT_SELECTION;
  if (!documentOnly && input.selection) {
    const minted = selectionFromRequest(input.selection);
    if (!minted.ok) {
      return apiError(
        `Unknown selection leaf: ${minted.error.unknownLeaves.join(", ")}`,
        422,
        { errorCode: "share-link.selection.unknown_leaf" },
      );
    }
    selection = minted.selection;
  }

  // The insurance leaf is refused on a share link. The share view has never
  // decrypted the insurance number, and refusing it here makes that structural
  // rather than incidental: there is no path by which a link could carry it.
  const forbidden = SHARE_LINK_FORBIDDEN_LEAVES.filter((leaf) =>
    selection.has(leaf),
  );
  if (forbidden.length > 0) {
    return apiError(`A share link cannot carry: ${forbidden.join(", ")}`, 422, {
      errorCode: "share-link.selection.forbidden_leaf",
    });
  }

  const sectionsJson = selectionToBlob(selection);
  annotate({
    meta: { documentOnly, leafCount: selection.leaves.length },
  });

  // Mint the 192-bit raw token, store only its HMAC hash.
  const rawToken = `hls_${randomBytes(24).toString("hex")}`;
  const tokenHash = hashToken(rawToken);

  // v1.18.7 — always mint a passphrase second factor; store only its HMAC
  // hash. The raw passphrase is returned exactly once below. `normalisePassphrase`
  // is the canonical store form so the grouped (`XXXX-XXXX-…`) display and the
  // bare fragment value collide to one hash.
  const rawPassphrase = generatePassphrase();
  const passphraseHash = hashPassphrase(normalisePassphrase(rawPassphrase)!);

  // v1.28 — resolve the frozen document set. The ids are deduped (a client
  // could repeat one, which the unique membership index would otherwise
  // reject) and then validated as the caller's OWN live documents. A single
  // foreign / deleted / unknown id seals the whole create as 422 — no share is
  // ever minted with a document the caller does not own (B5). The rows are
  // created in the SAME transaction as the link (nested create), so the
  // membership is frozen write-once atomically with the scope columns.
  const documentIds = Array.from(new Set(input.documentIds ?? []));
  if (documentIds.length > 0) {
    const owned = await prisma.inboundDocument.findMany({
      where: { id: { in: documentIds }, userId: user.id, deletedAt: null },
      select: { id: true },
    });
    if (owned.length !== documentIds.length) {
      return apiError("One or more documents are not available to share", 422, {
        errorCode: "share-link.documents.invalid",
      });
    }
  }

  // Field-by-field build — no mass assignment. Scope columns are written
  // exactly once here and never updated.
  const created = await prisma.clinicianShareLink.create({
    data: {
      userId: user.id,
      tokenHash,
      passphraseHash,
      label: input.label,
      rangeStart: new Date(input.rangeStart),
      rangeEnd: input.rangeEnd ? new Date(input.rangeEnd) : null,
      sectionsJson: sectionsJson as Prisma.InputJsonValue,
      documentOnly,
      expiresAt: new Date(input.expiresAt),
      documents:
        documentIds.length > 0
          ? { create: documentIds.map((documentId) => ({ documentId })) }
          : undefined,
    },
    select: shareLinkSummarySelect,
  });

  await auditLog("share-link.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      shareLinkId: created.id,
      documentCount: created._count.documents,
      expiresAt: created.expiresAt.toISOString(),
    },
  });

  // The raw token AND raw passphrase are returned exactly once; both are
  // unrecoverable thereafter. The QR/deep-link payload carries the passphrase
  // in the URL FRAGMENT (`#k=`) — never the path or query — so it is never
  // sent to the server, kept out of logs, referrers, and the access record.
  const origin = resolveOrigin(request);
  const shareUrl = `${origin}/c/${rawToken}`;
  const qrUrl = `${shareUrl}#${PASSPHRASE_FRAGMENT_KEY}=${rawPassphrase}`;
  return apiSuccess(
    {
      ...toSummary(created),
      token: rawToken,
      passphrase: rawPassphrase,
      shareUrl,
      qrUrl,
    },
    201,
  );
});

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "share-link.list" } });

  const rows = await prisma.clinicianShareLink.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: shareLinkSummarySelect,
  });

  return apiSuccess({
    shareLinks: rows.map((row) => toSummary(row)),
  });
});
