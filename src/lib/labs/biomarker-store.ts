/**
 * v1.18.1 — server-side helpers for the user-scoped Biomarker catalog.
 *
 * The AES-256-GCM ↔ `Bytes` codec for `Biomarker.contextEncrypted`. The
 * per-marker context note ("what this means") is the only sensitive column on
 * the model; it shares the `encrypt()` string format (`"<keyId>.<base64>"`)
 * every other `*Encrypted` column uses, encoded as UTF-8 bytes.
 *
 * Mirrors the `LabResult.noteEncrypted` codec in `./store.ts` so the two
 * encrypted columns on the Labs feature share one byte layout.
 */
import { Buffer } from "node:buffer";

import { decrypt, encrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { matchAnalyteKey } from "@/lib/labs/analyte-match";
import {
  addToIndex,
  loadMarkerIndex,
  resolveInIndex,
  type IndexedMarker,
  type MarkerIndex,
} from "@/lib/labs/biomarker-resolve";
import { mintedBounds } from "@/lib/labs/minted-bounds";
import { getEvent } from "@/lib/logging/context";

/** Encrypt a UTF-8 context note into the `Bytes` payload the schema stores. */
export function encryptContextToBytes(
  plaintext: string,
): Uint8Array<ArrayBuffer> {
  const ciphertext = encrypt(plaintext);
  const encoded = Buffer.from(ciphertext, "utf8");
  const out = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  out.set(encoded);
  return out;
}

/** Decrypt a stored `Bytes` context note back to plaintext. */
export function decryptContextFromBytes(buf: Uint8Array): string {
  return decrypt(Buffer.from(buf).toString("utf8"));
}

/** Decrypt a stored `Bytes` context note, fail-soft to `null` on any error.
 *
 * A single bad-key / malformed row must not 500 the whole catalog list, and
 * the list surface renders a missing context as nothing either way. The
 * single-resource GET path uses the throwing `decryptContextFromBytes` so a
 * genuine decrypt failure there surfaces instead of silently masking a
 * key-rotation gap, and the backup export reads through its own helper that
 * marks the row rather than blanking it. */
export function decryptContextSoft(buf: Uint8Array | null): string | null {
  if (!buf) return null;
  try {
    return decryptContextFromBytes(buf);
  } catch (err) {
    // Undecryptable context (key gap / corruption): fail soft to null so one
    // bad row never 500s the catalog list, but log it (F-CRYPTO-2) so a
    // systemic key gap surfaces instead of masking as an empty context.
    getEvent()?.addWarning(
      `biomarker context decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/** The minimal Biomarker shape the lab-write resolver returns. */
export interface MintedBiomarker {
  id: string;
  name: string;
  unit: string;
  lowerBound: number | null;
  upperBound: number | null;
  panel: string | null;
  analyteKey: string | null;
}

/**
 * v1.18.1 — resolve (or mint) the user-scoped Biomarker for a free-text lab
 * write so NO `LabResult` row ever persists unlinked.
 *
 * Since v1.43 (D1223) the name resolves through `resolveInIndex`: the
 * marker's own name (case aside), then an alias of the account, then a
 * catalog name for the same analyte as one of the account's markers ("GPT"
 * for "ALT") when the reading's unit fits that marker. An existing marker is
 * reused as-is: its unit / range are authoritative and the incoming free-text
 * unit / bounds are NOT allowed to silently rewrite it. When nothing resolves,
 * a marker is minted from the reading's own spelling / unit / bounds. The
 * bounds are the report's printed window whether the reading is a number or a
 * text result ("SEE NOTE" beside "10 - 20"): the marker outlives the reading,
 * and its next number is judged against them. A window that cannot be true
 * (low above high) is not minted; nothing says which of the two is wrong. A
 * text result that states no unit mints a marker with none, and its range is
 * then a unitless one: the first number keeps it only under the unity "1"
 * (`adoptFirstNumericUnit` in `./reading-conversion.ts`). The
 * `@@unique([userId, name])` index is the structural backstop; a concurrent
 * double-write converges via the catch-and-refetch.
 *
 * `index` lets a caller writing many rows load the account's markers once;
 * a marker minted here is added to it so a later row with the same name finds
 * it.
 */
export async function resolveOrMintBiomarker(
  userId: string,
  input: {
    analyte: string;
    unit: string;
    referenceLow: number | null;
    referenceHigh: number | null;
    panel: string | null;
  },
  options: { index?: MarkerIndex } = {},
): Promise<MintedBiomarker> {
  const name = input.analyte.trim();
  const index = options.index ?? (await loadMarkerIndex(prisma, userId));
  const hit = resolveInIndex(index, name, input.unit || null);
  if (hit) return toMinted(hit.marker);

  const { lowerBound, upperBound } = mintedBounds(
    input.referenceLow,
    input.referenceHigh,
  );
  try {
    const created = await prisma.biomarker.create({
      data: {
        userId,
        name,
        unit: input.unit,
        lowerBound,
        upperBound,
        panel: input.panel,
        analyteKey: matchAnalyteKey({ name, unit: input.unit }),
      },
      select: INDEXED_SELECT,
    });
    addToIndex(index, created);
    return toMinted(created);
  } catch {
    // A concurrent write minted the same `(userId, name)` first — adopt it.
    const raced = await prisma.biomarker.findFirst({
      where: { userId, name: { equals: name, mode: "insensitive" } },
      select: INDEXED_SELECT,
    });
    if (raced) {
      addToIndex(index, raced);
      return toMinted(raced);
    }
    throw new Error("Failed to resolve biomarker for lab write");
  }
}

const INDEXED_SELECT = {
  id: true,
  name: true,
  unit: true,
  lowerBound: true,
  upperBound: true,
  panel: true,
  analyteKey: true,
  hidden: true,
  createdAt: true,
} as const;

function toMinted(marker: IndexedMarker): MintedBiomarker {
  return {
    id: marker.id,
    name: marker.name,
    unit: marker.unit,
    lowerBound: marker.lowerBound,
    upperBound: marker.upperBound,
    panel: marker.panel,
    analyteKey: marker.analyteKey,
  };
}
