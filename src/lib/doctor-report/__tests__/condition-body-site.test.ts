/**
 * The conditions read for the doctor report carries the body site (v1.39.2).
 *
 * The site decrypts fail-soft per row, like every other free-text column the
 * report reads, and a side is carried only beside a site: a lone "left" in a
 * report says nothing and reads like an error.
 *
 * Mutation checks (each run, each seen red):
 *   - drop `bodySiteEncrypted` from the `select` → "maps the site and side"
 *     goes red;
 *   - let a decrypt error throw → "reads a site it cannot decrypt as none"
 *     goes red with the thrown error.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const findMany = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: { illnessEpisode: { findMany } } }));
vi.mock("@/lib/logging/context", () => ({ getEvent: () => undefined }));

import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { loadIllnessEpisodes } from "../clinical-records";

const START = new Date("2026-01-01T00:00:00.000Z");
const END = new Date("2026-06-30T00:00:00.000Z");

function row(over: Record<string, unknown>) {
  return {
    label: "Meniscus tear",
    type: "INJURY",
    lifecycle: "ACUTE",
    onsetAt: new Date("2026-05-01T00:00:00.000Z"),
    resolvedAt: null,
    bodySiteEncrypted: null,
    laterality: null,
    ...over,
  };
}

/** What a fake Prisma `select` would hand back: only the selected keys. */
function selected(rows: Record<string, unknown>[]) {
  findMany.mockImplementation(async (args: { select: Record<string, true> }) =>
    rows.map((r) =>
      Object.fromEntries(Object.keys(args.select).map((k) => [k, r[k]])),
    ),
  );
}

beforeEach(() => {
  findMany.mockReset();
});

describe("loadIllnessEpisodes — body site", () => {
  it("maps the site and side", async () => {
    selected([
      row({ bodySiteEncrypted: encryptToBytes("Knee"), laterality: "LEFT" }),
    ]);
    const out = await loadIllnessEpisodes("u1", START, END);
    expect(out?.[0]).toMatchObject({
      label: "Meniscus tear",
      bodySite: "Knee",
      laterality: "LEFT",
    });
  });

  it("carries no side without a site", async () => {
    selected([row({ laterality: "LEFT" })]);
    const out = await loadIllnessEpisodes("u1", START, END);
    expect(out?.[0]).toMatchObject({ bodySite: null, laterality: null });
  });

  it("reads a site it cannot decrypt as none", async () => {
    selected([
      row({
        bodySiteEncrypted: new Uint8Array([1, 2, 3]),
        laterality: "RIGHT",
      }),
    ]);
    const out = await loadIllnessEpisodes("u1", START, END);
    expect(out?.[0]).toMatchObject({ bodySite: null, laterality: null });
  });
});
