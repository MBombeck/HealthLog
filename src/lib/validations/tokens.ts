import { z } from "zod/v4";

/**
 * Body of `POST /api/tokens/measurements` — mint a Bearer for third-party
 * measurement ingest.
 *
 * There is deliberately no `scope` field. The MCP mint next door offers a
 * closed two-value choice because its two shapes mean different things; this
 * endpoint mints one shape and only one, so the request cannot express a scope
 * at all. That is the strongest form of the no-mass-assignment rule: not a
 * field validated against an allowlist, but a field that does not exist.
 *
 * `expiresInDays` is bounded rather than optional-and-unbounded because the
 * credential is pasted into something that runs unattended. The route's default
 * is deliberately long for the same reason — an automation that stops working
 * silently is worse than one that stops working loudly — but a caller who wants
 * a short-lived token can always ask for one.
 */
export const createMeasurementTokenSchema = z.object({
  name: z.string().min(1, "Name required").max(100),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

export type CreateMeasurementTokenInput = z.infer<
  typeof createMeasurementTokenSchema
>;

/**
 * Body of `POST /api/tokens/documents` — mint a Bearer that can upload
 * documents and nothing else. The same shape as the measurement mint and for
 * the same reasons: no scope field, a bounded lifetime.
 */
export const createDocumentTokenSchema = z.object({
  name: z.string().min(1, "Name required").max(100),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});
