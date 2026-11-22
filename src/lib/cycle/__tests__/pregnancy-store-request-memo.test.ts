/**
 * The pregnancy state is read once per GET request, however many weight
 * readers ask for it, and afresh everywhere else.
 *
 * A dashboard read asked for it from the targets, the verdicts and the score,
 * one point read each; the statement budgets of the hot routes caught the
 * second and third. A write path (a PATCH that sets the state, an import, a
 * job) must never be served an answer from before its own write.
 */
import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";

import { WideEventBuilder } from "@/lib/logging/event-builder";
import { eventStorage } from "@/lib/logging/context";

import { loadPregnancyFields } from "../pregnancy-store";

type CycleProfileClient = Pick<PrismaClient, "cycleProfile">;

function fakeDb() {
  const findUnique = vi.fn(
    async (): Promise<{
      pregnancyEncrypted: string | null;
      postpartumWeeks: number;
    }> => ({ pregnancyEncrypted: null, postpartumWeeks: 12 }),
  );
  const db = { cycleProfile: { findUnique } } as unknown as CycleProfileClient;
  return { db, findUnique };
}

function inRequest<T>(method: string, fn: () => Promise<T>): Promise<T> {
  const event = new WideEventBuilder();
  event.setHttp({ method, path: "/api/x", route: "/api/x", status: 200 });
  return eventStorage.run(event, fn);
}

describe("the pregnancy state read per request", () => {
  it("reads once in a GET request, for every reader in it", async () => {
    const { db, findUnique } = fakeDb();
    await inRequest("GET", async () => {
      await Promise.all([
        loadPregnancyFields(db, "u1"),
        loadPregnancyFields(db, "u1"),
      ]);
      await loadPregnancyFields(db, "u1");
    });
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("reads again in the next request", async () => {
    const { db, findUnique } = fakeDb();
    await inRequest("GET", () => loadPregnancyFields(db, "u1"));
    await inRequest("GET", () => loadPregnancyFields(db, "u1"));
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it("keeps records and clients apart", async () => {
    const a = fakeDb();
    const b = fakeDb();
    await inRequest("GET", async () => {
      await loadPregnancyFields(a.db, "u1");
      await loadPregnancyFields(a.db, "u2");
      await loadPregnancyFields(b.db, "u1");
    });
    expect(a.findUnique).toHaveBeenCalledTimes(2);
    expect(b.findUnique).toHaveBeenCalledTimes(1);
  });

  it("reads every time in a request that may write, and outside any request", async () => {
    const { db, findUnique } = fakeDb();
    await inRequest("PATCH", async () => {
      await loadPregnancyFields(db, "u1");
      await loadPregnancyFields(db, "u1");
    });
    await loadPregnancyFields(db, "u1");
    await loadPregnancyFields(db, "u1");
    expect(findUnique).toHaveBeenCalledTimes(4);
  });

  it("does not keep a failed read", async () => {
    const { db, findUnique } = fakeDb();
    findUnique.mockRejectedValueOnce(new Error("connection reset"));
    await inRequest("GET", async () => {
      await expect(loadPregnancyFields(db, "u1")).rejects.toThrow();
      await loadPregnancyFields(db, "u1");
    });
    expect(findUnique).toHaveBeenCalledTimes(2);
  });
});
