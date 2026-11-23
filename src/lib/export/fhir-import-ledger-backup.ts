/**
 * The FHIR Bundle import ledger (`FhirImportedResource`), with both backup
 * ends in one file.
 *
 * The ledger is what stops a second import of the same Bundle from writing
 * its conditions, vaccinations, medications and visits again; lab results and
 * vital signs carry their identity on their own rows. Without it in the file,
 * a restore onto a fresh instance followed by the same import doubled those
 * four kinds. Each entry is a digest of the issuer, the resource type and the
 * resource id: no content, the same in both purposes.
 *
 * `recordId` is the row the resource became when it was imported. The
 * restore maps a medication's id through the medication restore's id map
 * (medications get new ids); the other three kinds keep their ids. A ledger
 * row whose record is gone still dedupes, which is the rule the import
 * itself follows: deleting an imported record does not bring it back on the
 * next import.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { z } from "zod/v4";

import { isoDateTime } from "./backup-schema-kit";

import type { RestoreContext } from "./restore-context";

export const fhirImportedResourceBackupSchema = z
  .object({
    resourceType: z.string().min(1).max(64),
    resourceKey: z.string().regex(/^[0-9a-f]{40}$/),
    recordId: z.string().min(1).max(64),
    createdAt: isoDateTime.optional(),
  })
  .passthrough();

export interface FhirImportedResourceBackupEntry {
  resourceType: string;
  resourceKey: string;
  recordId: string;
  createdAt: string;
}

export async function buildFhirImportLedgerSlice(
  prisma: Pick<PrismaClient, "fhirImportedResource">,
  userId: string,
): Promise<{ fhirImportedResources: FhirImportedResourceBackupEntry[] }> {
  const rows = await prisma.fhirImportedResource.findMany({
    where: { userId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      resourceType: true,
      resourceKey: true,
      recordId: true,
      createdAt: true,
    },
  });
  return {
    fhirImportedResources: rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

/** Replace the ledger with the file's. After the medications. */
export async function restoreFhirImportLedger(
  ctx: RestoreContext,
): Promise<void> {
  const { tx, ownerId, payload } = ctx;
  const cleared = await tx.fhirImportedResource.deleteMany({
    where: { userId: ownerId },
  });
  ctx.cleared.fhirImportedResources = cleared.count;
  const entries = payload.fhirImportedResources ?? [];
  if (entries.length === 0) return;
  await tx.fhirImportedResource.createMany({
    data: entries.map((entry) => ({
      userId: ownerId,
      resourceType: entry.resourceType,
      resourceKey: entry.resourceKey,
      recordId:
        entry.resourceType === "MedicationStatement"
          ? (ctx.links.medicationIdBySourceId.get(entry.recordId) ??
            entry.recordId)
          : entry.recordId,
      ...(entry.createdAt ? { createdAt: new Date(entry.createdAt) } : {}),
    })),
    skipDuplicates: true,
  });
}
