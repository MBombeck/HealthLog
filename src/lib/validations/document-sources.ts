/**
 * Request schemas of the document picker (#1038): saving a connection,
 * searching a source, importing one picked document. No `userId` field in any
 * of them; the owner is always the authenticated session.
 */
import { z } from "zod/v4";

import { DOCUMENT_SOURCE_BASE_URL_MAX } from "@/lib/documents/sources/origins";
import {
  DOCUMENT_PICKER_LINK_KINDS,
  DOCUMENT_PICKER_MAX_PAGE,
  DOCUMENT_PICKER_QUERY_MAX,
  PAPRA_ORG_ID,
} from "@/lib/documents/sources/types";
import {
  documentSourceIdSchema,
  INBOUND_DOCUMENT_KINDS,
} from "@/lib/validations/inbound-documents";

/** Printable ASCII without spaces: an id or a key, never prose. */
const printable = /^[\x21-\x7e]+$/u;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "Expected a YYYY-MM-DD date");

/** Longest API token or key a connection stores. */
export const DOCUMENT_SOURCE_TOKEN_MAX = 512;

/**
 * Save a connection. `token` may be left out when a connection for the system
 * already exists: the stored one is kept, so the address or the organization
 * can change without typing the key again. The first save must carry it (the
 * route says so). `organizationId` is Papra's and required there.
 */
export const documentSourceSaveSchema = z.object({
  baseUrl: z.string().trim().min(1).max(DOCUMENT_SOURCE_BASE_URL_MAX),
  organizationId: z
    .string()
    .trim()
    .regex(PAPRA_ORG_ID, "Expected a Papra organization id (org_…)")
    .optional(),
  token: z
    .string()
    .trim()
    .min(1)
    .max(DOCUMENT_SOURCE_TOKEN_MAX)
    .regex(printable, "Expected printable characters without spaces")
    .optional(),
});
export type DocumentSourceSaveInput = z.infer<typeof documentSourceSaveSchema>;

export const documentSourceSearchSchema = z
  .object({
    q: z.string().trim().max(DOCUMENT_PICKER_QUERY_MAX).default(""),
    tag: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(printable, "Expected printable characters without spaces")
      .optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    page: z.coerce
      .number()
      .int()
      .min(1)
      .max(DOCUMENT_PICKER_MAX_PAGE)
      .default(1),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    path: ["to"],
    message: "The end date is before the start date",
  });

export const documentSourceImportSchema = z.object({
  sourceId: documentSourceIdSchema,
  kind: z.enum(INBOUND_DOCUMENT_KINDS).optional(),
  /** The record the picker was opened from, to link the document to. */
  link: z
    .object({
      kind: z.enum(DOCUMENT_PICKER_LINK_KINDS),
      id: z.string().trim().min(1).max(64),
    })
    .optional(),
  /**
   * The person chose to bring back a document they deleted in HealthLog. One
   * still in Recently deleted is restored (`restored`); one already removed
   * for good is fetched and stored again, and the import ledger forgets its
   * key. Without it a deleted document is answered `deleted` and left alone,
   * as an importer's upload always is.
   */
  revive: z.boolean().optional(),
});
export type DocumentSourceImportInput = z.infer<
  typeof documentSourceImportSchema
>;
