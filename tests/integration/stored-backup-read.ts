/**
 * Read a stored backup back as its JSON text, whichever form it was stored
 * in, through the same opener the restore, download and preview use.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import {
  openStoredBackup,
  STORED_BACKUP_SELECT,
} from "@/lib/export/stored-backup";

export async function readStoredBackup(
  prisma: PrismaClient,
  id: string,
): Promise<string> {
  const backup = await prisma.dataBackup.findUniqueOrThrow({
    where: { id },
    select: STORED_BACKUP_SELECT,
  });
  const source = await openStoredBackup(prisma, backup);
  const parts: Buffer[] = [];
  for await (const chunk of source()) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts).toString("utf8");
}
