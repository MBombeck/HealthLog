/**
 * Point a backup file at another account, on its way in.
 *
 * A backup names its owner once, in the top-level `userId` member. The restore
 * takes the account it writes from there and from nowhere else
 * (`checkOwnership` in `restore-preflight.ts`), and every domain writes its
 * rows under that account (`ctx.ownerId`), never under an id read from a row.
 * So the copy of an account that has since been erased goes into another
 * account by changing that one member, and nothing else in the file: the copy
 * stored is then that account's copy in every respect (its preview, its
 * download, its restore), and the erased id is stored nowhere, not even inside
 * the encrypted copy.
 *
 * This rewrites the member as the bytes stream past, without holding the
 * document (a disaster-recovery file can be longer than any string V8 can
 * hold, see `backup-json-scan.ts`). It tracks only string and nesting state,
 * and parses only the top-level keys and the one value it replaces. A key is
 * compared after `JSON.parse`, so an escaped spelling of `userId` is the same
 * key, exactly as the reader behind it sees it; a `userId` nested anywhere
 * below the top level is left alone. Every other byte passes through
 * unchanged.
 */

import { BackupJsonError } from "@/lib/export/backup-json-scan";

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COMMA = 0x2c;

/** Longer than any top-level key a backup carries. */
const MAX_KEY_BYTES = 256;
/** Far longer than any account id; a longer owner is not an id. */
const MAX_OWNER_BYTES = 1024;

/** The file's owner member is not something this can rewrite. */
export class BackupOwnerRewriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupOwnerRewriteError";
  }
}

type StringRole = "key" | "owner" | "other";

export interface BackupOwnerRewrite {
  /** The bytes, with every top-level `userId` string set to the target. */
  bytes: AsyncGenerator<Buffer>;
  /**
   * The owner the file declared, once the stream has passed it: the last
   * top-level `userId` string, which is the one `JSON.parse` keeps. Null when
   * the file has none.
   */
  declaredOwner(): string | null;
}

export function rewriteBackupOwner(
  source: AsyncIterable<Uint8Array>,
  targetId: string,
): BackupOwnerRewrite {
  const replacement = Buffer.from(JSON.stringify(targetId), "utf8");
  let declared: string | null = null;

  async function* bytes(): AsyncGenerator<Buffer> {
    let depth = 0;
    let topIsObject = false;
    let expectKey = false;
    let lastKey: string | null = null;
    let inString = false;
    let escaped = false;
    let role: StringRole = "other";
    // The key or owner string being collected, across chunks.
    let collected: Buffer[] = [];
    let collectedBytes = 0;

    for await (const raw of source) {
      const chunk = Buffer.isBuffer(raw)
        ? raw
        : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
      const out: Buffer[] = [];
      // Where the bytes passed through unchanged start in this chunk; -1
      // while the owner value is being withheld.
      let passFrom = role === "owner" && inString ? -1 : 0;
      // Where the string being collected starts in this chunk.
      let collectFrom = 0;

      const collect = (to: number) => {
        if (to > collectFrom) {
          collected.push(chunk.subarray(collectFrom, to));
          collectedBytes += to - collectFrom;
        }
        if (role === "key" && collectedBytes > MAX_KEY_BYTES) {
          // Not a key this rewrite cares about; stop collecting it.
          role = "other";
          collected = [];
          collectedBytes = 0;
        }
        if (role === "owner" && collectedBytes > MAX_OWNER_BYTES) {
          throw new BackupOwnerRewriteError(
            "The file's owner is too long to be an account id",
          );
        }
      };
      const take = (): string => {
        const text = Buffer.concat(collected, collectedBytes).toString("utf8");
        collected = [];
        collectedBytes = 0;
        try {
          return JSON.parse(text) as string;
        } catch {
          throw new BackupJsonError(
            "A top-level string in the file is not valid JSON",
          );
        }
      };

      for (let i = 0; i < chunk.length; i++) {
        const byte = chunk[i]!;
        if (inString) {
          if (escaped) escaped = false;
          else if (byte === BACKSLASH) escaped = true;
          else if (byte === QUOTE) {
            inString = false;
            if (role === "key") {
              collect(i + 1);
              lastKey = role === "key" ? take() : null;
              expectKey = false;
            } else if (role === "owner") {
              collect(i + 1);
              declared = take();
              out.push(replacement);
              passFrom = i + 1;
            }
            role = "other";
          }
          continue;
        }
        if (byte === QUOTE) {
          inString = true;
          if (depth === 1 && topIsObject && expectKey) {
            role = "key";
            collectFrom = i;
          } else if (depth === 1 && topIsObject && lastKey === "userId") {
            role = "owner";
            collectFrom = i;
            if (passFrom >= 0) out.push(chunk.subarray(passFrom, i));
            passFrom = -1;
          } else {
            role = "other";
          }
          continue;
        }
        if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
          depth += 1;
          if (depth === 1) {
            topIsObject = byte === OPEN_BRACE;
            expectKey = topIsObject;
          }
          continue;
        }
        if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
          depth -= 1;
          continue;
        }
        if (byte === COMMA && depth === 1) {
          expectKey = topIsObject;
          lastKey = null;
        }
      }

      if (inString && (role === "key" || role === "owner")) {
        collect(chunk.length);
      }
      if (passFrom >= 0) out.push(chunk.subarray(passFrom));
      const piece = out.length === 1 ? out[0]! : Buffer.concat(out);
      if (piece.byteLength > 0) yield piece;
    }
  }

  return { bytes: bytes(), declaredOwner: () => declared };
}
