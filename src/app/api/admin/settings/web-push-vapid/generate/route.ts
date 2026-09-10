import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import {
  apiError,
  apiSuccess,
  apiValidationError,
  getClientIp,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { encrypt } from "@/lib/crypto";
import { z } from "zod/v4";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const generateSchema = z
  .object({
    // Overwrite guard — the client must opt in to replacing an existing
    // keypair. Regenerating invalidates every browser subscription signed
    // against the old public key, so the UI confirms before sending this.
    force: z.boolean().optional(),
    // Optional subject override. When omitted the existing subject is kept,
    // or a neutral placeholder seeded so the keypair is immediately usable.
    subject: z
      .string()
      .refine((v) => !v.trim() || /^mailto:.+@.+$/.test(v.trim()), {
        message: "subject must be in mailto:address@example.com format",
      })
      .optional(),
  })
  .strict();

/**
 * POST /api/admin/settings/web-push-vapid/generate
 *
 * Server-side VAPID keypair generation — the self-hoster DX win. Calls
 * `web-push`'s `generateVAPIDKeys()`, encrypts the private key at rest
 * (`src/lib/crypto.ts`), and persists the pair onto the AppSettings
 * singleton. Returns only the public key + subject; the private key never
 * leaves the server and is never logged (the egress redactor covers the
 * encrypted blob, and the audit detail carries only a "generated" marker).
 *
 * Cookie-only via `requireAdmin()` — a Bearer token can never reach it.
 *
 * Overwrite guard: if a keypair already exists, the call refuses with 409
 * unless `force: true` is supplied. Regenerating invalidates existing
 * browser subscriptions, so the operator must opt in.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();
  annotate({ action: { name: "admin.webPushVapid.generate" } });

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 4 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = generateSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return apiValidationError(
      "Invalid request",
      sanitiseZodIssues(parsed.error.issues),
      422,
    );
  }

  const existing = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: {
      webPushVapidPublicKey: true,
      webPushVapidPrivateKeyEncrypted: true,
      webPushVapidSubject: true,
    },
  });

  const alreadyConfigured = Boolean(
    existing?.webPushVapidPublicKey &&
    existing?.webPushVapidPrivateKeyEncrypted,
  );

  if (alreadyConfigured && parsed.data.force !== true) {
    // Overwrite guard — surface the existing public key so the UI can warn
    // the operator that regenerating invalidates current subscriptions.
    return apiError(
      "VAPID keys already configured. Regenerating invalidates existing browser subscriptions. Resend with force to replace them.",
      409,
    );
  }

  // Lazy import — mirrors the sender so a build without `web-push` still
  // type-checks. `generateVAPIDKeys()` returns Base64URL public + private.
  const webpush = await import("web-push");
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();

  // Subject precedence: explicit override → existing subject → placeholder.
  // The placeholder keeps the keypair immediately valid; the admin edits
  // the real contact address inline in the card afterwards.
  const subjectOverride = parsed.data.subject?.trim();
  const subject =
    (subjectOverride && subjectOverride.length > 0
      ? subjectOverride
      : existing?.webPushVapidSubject) || "mailto:admin@example.com";

  await prisma.appSettings.upsert({
    where: { id: "singleton" },
    update: {
      webPushVapidPublicKey: publicKey,
      webPushVapidPrivateKeyEncrypted: encrypt(privateKey),
      webPushVapidSubject: subject,
    },
    create: {
      id: "singleton",
      webPushVapidPublicKey: publicKey,
      webPushVapidPrivateKeyEncrypted: encrypt(privateKey),
      webPushVapidSubject: subject,
    },
  });

  await auditLog("admin.web_push_vapid.generate", {
    userId: user.id,
    ipAddress: getClientIp(request),
    // Never the private key — only a marker that a fresh pair was minted
    // and whether it replaced an existing one.
    details: {
      webPushVapidPrivateKeyUpdated: true,
      replacedExisting: alreadyConfigured,
      webPushVapidSubject: subject,
    },
  });

  // Public key + subject only; the private key stays server-side.
  return apiSuccess({
    webPushVapidPublicKey: publicKey,
    webPushVapidSubject: subject,
    webPushVapidConfigured: true,
  });
});
