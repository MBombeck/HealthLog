/**
 * `scanBackupJson` must read a backup exactly as `JSON.parse` of the whole
 * document would, with the streamed members handed out one element at a time
 * (issue #1031: a 662 MB backup cannot exist as one string). These tests hold
 * it to that over awkward values and arbitrary chunk boundaries, including
 * boundaries inside strings, escapes and multi-byte characters.
 */
import { describe, expect, it } from "vitest";

import { BackupJsonError, scanBackupJson } from "../backup-json-scan";

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

function rng(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    return x / 2 ** 31;
  };
}

const AWKWARD = [
  'quote " inside',
  "back\\slash and \\n",
  "brackets ] } [ { , : in a string",
  "umlaut ä ö ü and emoji 🫀",
  "",
  "\u0000\u001f control",
];

function randomValue(rand: () => number, depth: number): unknown {
  const r = rand();
  if (depth > 2 || r < 0.35) {
    const p = rand();
    if (p < 0.2) return null;
    if (p < 0.3) return rand() < 0.5;
    if (p < 0.55) return Math.round(rand() * 1e6) / 100 - 500;
    return (
      AWKWARD[Math.floor(rand() * AWKWARD.length)]! + Math.floor(rand() * 9)
    );
  }
  if (r < 0.65) {
    return Array.from({ length: Math.floor(rand() * 4) }, () =>
      randomValue(rand, depth + 1),
    );
  }
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < Math.floor(rand() * 4); i++) {
    obj[`${AWKWARD[i % AWKWARD.length]}-${i}`] = randomValue(rand, depth + 1);
  }
  return obj;
}

function randomDocument(seed: number) {
  const rand = rng(seed);
  return {
    schemaVersion: "2",
    userId: "user-ä",
    measurements: Array.from({ length: Math.floor(rand() * 30) }, (_, i) =>
      i % 5 === 4
        ? randomValue(rand, 1)
        : { id: `m${i}`, notes: AWKWARD[i % 6] },
    ),
    medications: [randomValue(rand, 0), randomValue(rand, 0)],
    moodEntries: [],
    count: 42,
    flag: false,
    nothing: null,
    text: AWKWARD[seed % AWKWARD.length],
    nested: randomValue(rand, 0),
  };
}

async function scan(text: string, sizes: number[], streamKeys: string[]) {
  const elements: Record<string, unknown[]> = {};
  const result = await scanBackupJson(chunked(text, sizes), {
    streamKeys: new Set(streamKeys),
    onElement: (key, element, index) => {
      (elements[key] ??= [])[index] = element;
    },
  });
  return { ...result, elements };
}

describe("scanBackupJson", () => {
  it("equals JSON.parse over random documents, formats and chunk splits", async () => {
    for (let seed = 1; seed <= 200; seed++) {
      const doc = randomDocument(seed);
      const text =
        seed % 3 === 0
          ? JSON.stringify(doc, null, seed % 2 ? 2 : "\t")
          : JSON.stringify(doc);
      const sizes = [1 + (seed % 7), 2, 13, 1, 64].slice(seed % 3);
      const { document, streamedCounts, elements } = await scan(text, sizes, [
        "measurements",
        "moodEntries",
      ]);
      const expected = JSON.parse(text) as Record<string, unknown>;

      expect(elements.measurements ?? [], `seed ${seed}`).toEqual(
        expected.measurements,
      );
      expect(streamedCounts).toEqual({
        measurements: (expected.measurements as unknown[]).length,
        moodEntries: 0,
      });
      expect(document, `seed ${seed}`).toEqual({
        ...expected,
        measurements: [],
        moodEntries: [],
      });
    }
  });

  it("hands out streamed elements before it has read the rest of the document", async () => {
    const text = JSON.stringify({
      a: 1,
      measurements: [{ id: "x" }, { id: "y" }],
      tail: "z".repeat(100),
    });
    const bytes = Buffer.from(text);
    let delivered = 0;
    const seenAt: number[] = [];
    async function* source() {
      for (let i = 0; i < bytes.length; i += 4) {
        delivered = i + 4;
        yield bytes.subarray(i, i + 4);
      }
    }
    await scanBackupJson(source(), {
      streamKeys: new Set(["measurements"]),
      onElement: () => {
        seenAt.push(delivered);
      },
    });
    expect(seenAt).toHaveLength(2);
    expect(seenAt[1]!).toBeLessThan(bytes.length - 100);
  });

  it("skips a member it was told to skip without keeping it", async () => {
    const { document } = await scanBackupJson(
      chunked('{"a":[1,{"b":"]"}],"big":{"x":[1,2,3]},"c":"d"}', [3]),
      { skipKeys: new Set(["big"]) },
    );
    expect(document).toEqual({ a: [1, { b: "]" }], c: "d" });
  });

  it("refuses a truncated or malformed document", async () => {
    for (const bad of [
      '{"a":1',
      '{"a":[1,2}',
      "[1,2]",
      '{"measurements":{"x":1}}',
      '{"a":1}{',
      '{"measurements":[{"id":1} {"id":2}]}',
    ]) {
      await expect(
        scanBackupJson(chunked(bad, [2]), {
          streamKeys: new Set(["measurements"]),
        }),
        bad,
      ).rejects.toBeInstanceOf(BackupJsonError);
    }
  });

  it("propagates a failure from the element consumer", async () => {
    await expect(
      scanBackupJson(chunked('{"measurements":[1,2,3]}', [5]), {
        streamKeys: new Set(["measurements"]),
        onElement: (_key, _element, index) => {
          if (index === 1) throw new Error("consumer failed");
        },
      }),
    ).rejects.toThrow("consumer failed");
  });
});
