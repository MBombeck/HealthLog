/**
 * v1.7.0 — opaque keyset cursor codec for `/api/sync/changes`.
 */
import { describe, it, expect } from "vitest";

import { encodeCursor, decodeCursor } from "../cursor";

describe("sync cursor codec", () => {
  it("round-trips a keyset position through encode/decode", () => {
    const pos = { updatedAtMs: 1_717_000_000_000, id: "clx0abc123" };
    const token = encodeCursor(pos);
    expect(typeof token).toBe("string");
    expect(decodeCursor(token)).toEqual(pos);
  });

  it("produces a base64url token with no JSON-visible structure", () => {
    const token = encodeCursor({ updatedAtMs: 1, id: "z" });
    // Opaque to the client — must not contain `{` / `:` / `updatedAt`.
    expect(token).not.toMatch(/[{}:"]/);
    expect(token).not.toContain("updatedAt");
  });

  it("returns null for a garbage / unparseable token", () => {
    expect(decodeCursor("not-a-cursor!!!")).toBeNull();
    expect(decodeCursor("")).toBeNull();
    // valid base64url but not the expected JSON shape
    expect(decodeCursor(Buffer.from("[]").toString("base64url"))).toBeNull();
    expect(
      decodeCursor(Buffer.from('{"u":"x","i":1}').toString("base64url")),
    ).toBeNull();
  });
});
