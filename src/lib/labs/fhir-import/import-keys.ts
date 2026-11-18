/**
 * The import ledger of Health Records lab readings the person deleted
 * (`LabResultImportKey`, #1400).
 *
 * A deleted reading first waits as a tombstone, and its own `externalId` is
 * the memory that the person deleted it: the import finds the row and answers
 * "duplicate". Two things remove the row for good, the nightly tombstone purge
 * and deleting the reading's whole marker, and both used to take that memory
 * with them, so the next Apple Health export (which carries the whole history
 * every time) wrote the reading again. Each now calls
 * {@link retireLabImportKeys} in the same transaction as the delete, which
 * moves the identities of the rows about to go into the ledger.
 *
 * The ledger holds the digest only, never lab content. It is read by
 * {@link heldLabImportKeys} (the import's duplicate check) and carried by the
 * backup (`src/lib/export/labs-backup.ts`), together with the identities of
 * the deleted readings a portable file leaves out.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

type LedgerClient = Pick<PrismaClient, "labResult" | "labResultImportKey">;

/**
 * Move the identities of the lab rows `where` selects into the ledger, before
 * the caller deletes those rows. Rows without an identity are not imported
 * from anywhere and have nothing to remember. Run it inside the delete's
 * transaction so the identity and the row never both go missing.
 */
export async function retireLabImportKeys(
  tx: LedgerClient,
  userId: string,
  where: Prisma.LabResultWhereInput,
): Promise<number> {
  const rows = await tx.labResult.findMany({
    where: { ...where, userId, externalId: { not: null } },
    select: { source: true, externalId: true },
  });
  if (rows.length === 0) return 0;
  const { count } = await tx.labResultImportKey.createMany({
    data: rows.map((row) => ({
      userId,
      source: row.source,
      externalId: row.externalId!,
    })),
    skipDuplicates: true,
  });
  return count;
}

/** The identities among `externalIds` the ledger holds as deleted. */
export async function heldLabImportKeys(
  client: Pick<PrismaClient, "labResultImportKey">,
  userId: string,
  source: string,
  externalIds: readonly string[],
): Promise<Set<string>> {
  if (externalIds.length === 0) return new Set();
  const rows = await client.labResultImportKey.findMany({
    where: { userId, source, externalId: { in: [...externalIds] } },
    select: { externalId: true },
  });
  return new Set(rows.map((row) => row.externalId));
}
