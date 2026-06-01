/**
 * v1.7.0 — opaque multi-domain keyset cursor codec for `/api/sync/changes`.
 */
import { describe, it, expect } from "vitest";

import { encodeCursor, decodeCursor, type SyncCursor } from "../cursor";

describe("sync cursor codec", () => {
  it("round-trips a per-domain keyset map through encode/decode", () => {
    const cursor: SyncCursor = {
      measurements: { updatedAtMs: 1_717_000_000_000, id: "clx0meas" },
      mood: { updatedAtMs: 1_717_000_500_000, id: "clx0mood" },
      intakes: { updatedAtMs: 1_717_000_900_000, id: "clx0intk" },
    };
    const token = encodeCursor(cursor);
    expect(typeof token).toBe("string");
    expect(decodeCursor(token)).toEqual(cursor);
  });

  it("round-trips a partial map (only some domains advanced)", () => {
    const cursor: SyncCursor = {
      measurements: { updatedAtMs: 1_717_000_000_000, id: "clx0meas" },
    };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("round-trips an empty map (every domain a fresh scan)", () => {
    expect(decodeCursor(encodeCursor({}))).toEqual({});
  });

  it("produces a base64url token with no JSON-visible structure", () => {
    const token = encodeCursor({
      measurements: { updatedAtMs: 1, id: "z" },
    });
    // Opaque to the client — must not contain `{` / `:` / `updatedAt`.
    expect(token).not.toMatch(/[{}:"]/);
    expect(token).not.toContain("updatedAt");
  });

  it("returns null for a garbage / unparseable token", () => {
    expect(decodeCursor("not-a-cursor!!!")).toBeNull();
    expect(decodeCursor("")).toBeNull();
    // valid base64url but not the expected JSON shape
    expect(decodeCursor(Buffer.from("[]").toString("base64url"))).toBeNull();
    // wrong version
    expect(
      decodeCursor(Buffer.from('{"v":2,"d":{}}').toString("base64url")),
    ).toBeNull();
    // missing the `d` envelope
    expect(
      decodeCursor(Buffer.from('{"v":1}').toString("base64url")),
    ).toBeNull();
  });

  it("drops a domain whose watermark is malformed but keeps valid ones", () => {
    // measurements has a string `u` (invalid); mood is well-formed.
    const token = Buffer.from(
      JSON.stringify({
        v: 1,
        d: {
          measurements: { u: "x", i: "z" },
          mood: { u: 5, i: "clx0mood" },
        },
      }),
    ).toString("base64url");
    expect(decodeCursor(token)).toEqual({
      mood: { updatedAtMs: 5, id: "clx0mood" },
    });
  });
});
