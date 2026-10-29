/**
 * `rewriteBackupOwner` must change the top-level `userId` and nothing else,
 * over any chunk boundaries: the output parses to the input with that one
 * member replaced, and is byte-identical to it everywhere outside the value.
 */
import { describe, expect, it } from "vitest";

import { BackupJsonError } from "../backup-json-scan";
import {
  BackupOwnerRewriteError,
  rewriteBackupOwner,
} from "../backup-owner-rewrite";

async function* chunked(text: string, sizes: number[]) {
  const bytes = Buffer.from(text, "utf8");
  let at = 0;
  let i = 0;
  while (at < bytes.length) {
    const size = sizes[i++ % sizes.length]!;
    yield bytes.subarray(at, at + size);
    at += size;
  }
}

async function run(text: string, target: string, sizes: number[] = [7]) {
  const rewrite = rewriteBackupOwner(chunked(text, sizes), target);
  const parts: Buffer[] = [];
  for await (const part of rewrite.bytes) parts.push(part);
  return {
    text: Buffer.concat(parts).toString("utf8"),
    declared: rewrite.declaredOwner(),
  };
}

const NESTED = {
  schemaVersion: "2",
  exportedAt: "2026-10-01T00:00:00.000Z",
  userId: "cerased0000000000000000",
  measurements: [
    { id: "m1", userId: "cerased0000000000000000", note: 'a "userId": x' },
  ],
  profile: { userId: "cerased0000000000000000", name: "ä ö ü 🫀 } ] , :" },
  notes: ["userId", "brackets ] } [ {"],
};

describe("rewriteBackupOwner", () => {
  it("replaces only the top-level owner, at every chunk size", async () => {
    const text = JSON.stringify(NESTED, null, 1);
    for (const sizes of [[1], [2], [3], [5, 1, 9], [64], [text.length]]) {
      const out = await run(text, "ctarget0000000000000000", sizes);
      expect(out.declared).toBe("cerased0000000000000000");
      expect(JSON.parse(out.text)).toEqual({
        ...NESTED,
        userId: "ctarget0000000000000000",
      });
      // Outside the value, the bytes are the input's.
      expect(out.text).toBe(
        text.replace(
          '"userId": "cerased0000000000000000"',
          '"userId": "ctarget0000000000000000"',
        ),
      );
    }
  });

  it("reads an escaped spelling of the key as the key", async () => {
    const text = '{"user\\u0049d":"cold","a":[1,{"userId":"keep"}]}';
    const out = await run(text, "cnew", [1]);
    expect(out.declared).toBe("cold");
    expect(JSON.parse(out.text)).toEqual({
      userId: "cnew",
      a: [1, { userId: "keep" }],
    });
  });

  it("replaces every top-level owner and declares the last, as JSON.parse keeps it", async () => {
    const text = '{"userId":"first","x":1,"userId":"second"}';
    const out = await run(text, "cnew", [4]);
    expect(out.declared).toBe(JSON.parse(text).userId);
    expect(out.text).toBe('{"userId":"cnew","x":1,"userId":"cnew"}');
  });

  it("leaves a file without an owner unchanged and declares none", async () => {
    const text = '{"schemaVersion":"2","rows":[{"userId":"nested"}]}';
    const out = await run(text, "cnew", [3]);
    expect(out.declared).toBeNull();
    expect(out.text).toBe(text);
  });

  it("leaves a value that is a string elsewhere, or not a string, alone", async () => {
    const text = '{"name":"userId","userId":42}';
    const out = await run(text, "cnew", [2]);
    expect(out.declared).toBeNull();
    expect(out.text).toBe(text);
  });

  it("leaves a top-level array alone", async () => {
    const text = '["userId","x"]';
    const out = await run(text, "cnew");
    expect(out.declared).toBeNull();
    expect(out.text).toBe(text);
  });

  it("refuses an owner too long to be an id", async () => {
    const text = JSON.stringify({ userId: "x".repeat(4096) });
    await expect(run(text, "cnew", [100])).rejects.toBeInstanceOf(
      BackupOwnerRewriteError,
    );
  });

  it("refuses a top-level key that is not valid JSON", async () => {
    await expect(run('{"bad\\q":1}', "cnew")).rejects.toBeInstanceOf(
      BackupJsonError,
    );
  });
});
