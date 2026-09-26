/**
 * The single-value backup form v1.38.6 to v1.39.1 wrote into `data_backups.data`: the
 * JSON gzipped, then sealed as one AES-256-GCM stream (`~hlgcm1.…`).
 *
 * Nothing in the app writes it any more; copies stored in pieces replaced it
 * in v1.39.2. Copies in this form still exist on every host that ran those releases,
 * and they still have to restore, so the tests build them with this.
 */
import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";

import { createStreamEncryptor } from "@/lib/crypto";
import type { BackupJsonProducer } from "@/lib/export/backup-blob";

/** `json` in the v1.39.1 single-value form, under the active key. */
export function legacyStreamedBlob(json: string | Buffer): string {
  const encryptor = createStreamEncryptor();
  const body = encryptor.update(gzipSync(json));
  return `${encryptor.header}${body}${encryptor.final()}`;
}

/** The same, from a producer that writes the JSON in pieces. */
export async function legacyStreamedBlobFrom(
  producer: BackupJsonProducer,
): Promise<string> {
  const pieces: Buffer[] = [];
  await producer(async (chunk) => {
    pieces.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  });
  return legacyStreamedBlob(Buffer.concat(pieces));
}
