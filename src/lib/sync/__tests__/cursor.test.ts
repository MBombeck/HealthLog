/**
 * v1.7.0 — opaque multi-domain keyset cursor codec for `/api/sync/changes`.
 */
import { describe, it, expect } from "vitest";

import {
  encodeCursor,
  decodeCursor,
  decodeCursorIssuedAt,
  encodeCursorAtNow,
  SYNC_DOMAINS,
  type SyncCursor,
} from "../cursor";

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
    // unsupported version (v3 is not yet a thing) → clean re-init.
    expect(
      decodeCursor(Buffer.from('{"v":3,"d":{}}').toString("base64url")),
    ).toBeNull();
    // a non-numeric version is garbage too.
    expect(
      decodeCursor(Buffer.from('{"v":"1","d":{}}').toString("base64url")),
    ).toBeNull();
    // missing the `d` envelope
    expect(
      decodeCursor(Buffer.from('{"v":2}').toString("base64url")),
    ).toBeNull();
  });

  it("decodes a live v1 beta token additively — keeps known domains, fresh-scans the two new ones", () => {
    // A pre-cycle v1 cursor only ever carried measurements/mood/intakes.
    // It must NOT force a full re-init now that v2 added cycleDays/cycles;
    // the known watermarks survive and the new domains decode as absent
    // (a fresh scan of just those two).
    const v1Token = Buffer.from(
      JSON.stringify({
        v: 1,
        d: {
          measurements: { u: 1_717_000_000_000, i: "clx0meas" },
          mood: { u: 1_717_000_500_000, i: "clx0mood" },
          intakes: { u: 1_717_000_900_000, i: "clx0intk" },
        },
      }),
    ).toString("base64url");
    const decoded = decodeCursor(v1Token);
    expect(decoded).toEqual({
      measurements: { updatedAtMs: 1_717_000_000_000, id: "clx0meas" },
      mood: { updatedAtMs: 1_717_000_500_000, id: "clx0mood" },
      intakes: { updatedAtMs: 1_717_000_900_000, id: "clx0intk" },
    });
    // cycleDays + cycles absent → caller fresh-scans only those domains.
    expect(decoded?.cycleDays).toBeUndefined();
    expect(decoded?.cycles).toBeUndefined();
  });

  it("decodes a current-version empty envelope to a fresh-scan map", () => {
    expect(
      decodeCursor(Buffer.from('{"v":2,"d":{}}').toString("base64url")),
    ).toEqual({});
  });

  it("round-trips the v1.15.0 cycle domains", () => {
    const cursor: SyncCursor = {
      cycleDays: { updatedAtMs: 1_717_001_000_000, id: "clx0cday" },
      cycles: { updatedAtMs: 1_717_001_500_000, id: "clx0cyc" },
    };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("drops a domain whose watermark is malformed but keeps valid ones", () => {
    // measurements has a string `u` (invalid); mood is well-formed.
    const token = Buffer.from(
      JSON.stringify({
        v: 2,
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

describe("cursor issue time (sync reset)", () => {
  const cursor: SyncCursor = {
    measurements: { updatedAtMs: 1_000, id: "clx0m" },
  };

  it("round-trips the issue time beside the watermarks", () => {
    const token = encodeCursor(cursor, 1_790_000_000_000);
    expect(decodeCursorIssuedAt(token)).toBe(1_790_000_000_000);
    expect(decodeCursor(token)).toEqual(cursor);
  });

  it("reads no issue time from a token that carries none", () => {
    expect(decodeCursorIssuedAt(encodeCursor(cursor))).toBeNull();
    expect(decodeCursorIssuedAt("not a token")).toBeNull();
  });
});

describe("encodeCursorAtNow", () => {
  it("places every domain at the instant, before any id in that millisecond", () => {
    const nowMs = 1_790_000_000_123;
    const token = encodeCursorAtNow(nowMs);
    const cursor = decodeCursor(token);
    for (const domain of SYNC_DOMAINS) {
      expect(cursor?.[domain], domain).toEqual({ updatedAtMs: nowMs, id: "0" });
    }
    expect(decodeCursorIssuedAt(token)).toBe(nowMs);
    // Every cuid sorts after the tie-breaker, so a row in the same
    // millisecond is delivered, not skipped.
    expect("0" < "c").toBe(true);
    expect("0" < "a").toBe(true);
  });
});
