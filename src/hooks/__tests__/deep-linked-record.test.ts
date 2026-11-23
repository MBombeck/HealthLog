/**
 * `/care?visit=<id>` from a search hit. The visits list reads the newest
 * hundred of each arm, and a search reaches back further than that, so a hit
 * can name a visit the list does not hold. That visit is read on its own and
 * opened like a listed one.
 */
import { describe, expect, it, vi } from "vitest";

import { openDeepLinked } from "../use-deep-linked-record";

type Visit = { id: string; occurredAt: string };

/** The newest hundred visits, the way the list holds them. */
const newestHundred: Visit[] = Array.from({ length: 100 }, (_, i) => ({
  id: `v${i}`,
  occurredAt: `2026-01-01T00:00:00Z`,
}));
const older: Visit = { id: "v-older", occurredAt: "2014-05-06T09:00:00Z" };

describe("a link to a visit older than the newest hundred", () => {
  it("reads it on its own and opens it", async () => {
    const resolve = vi.fn(async (id: string) =>
      id === older.id ? older : null,
    );
    const open = vi.fn();
    const scrollTo = vi.fn();

    const outcome = await openDeepLinked({
      wanted: older.id,
      records: newestHundred,
      open,
      resolve,
      stillWanted: () => true,
      scrollTo,
    });

    expect(outcome).toBe("resolved");
    expect(resolve).toHaveBeenCalledWith("v-older");
    expect(open).toHaveBeenCalledWith(older);
    // Not on the page, so there is nothing to scroll to.
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("opens a listed visit without a second read", async () => {
    const resolve = vi.fn();
    const open = vi.fn();
    const scrollTo = vi.fn();
    const outcome = await openDeepLinked({
      wanted: "v42",
      records: newestHundred,
      open,
      resolve,
      stillWanted: () => true,
      scrollTo,
    });
    expect(outcome).toBe("listed");
    expect(resolve).not.toHaveBeenCalled();
    expect(scrollTo).toHaveBeenCalledWith("v42");
    expect(open).toHaveBeenCalledWith(newestHundred[42]);
  });

  it("leaves the page alone when the visit is gone or refused", async () => {
    const open = vi.fn();
    for (const resolve of [
      async () => null,
      async () => {
        throw new Error("403");
      },
    ]) {
      const outcome = await openDeepLinked({
        wanted: "v-gone",
        records: newestHundred,
        open,
        resolve,
        stillWanted: () => true,
        scrollTo: () => {},
      });
      expect(outcome).toBe("none");
    }
    expect(open).not.toHaveBeenCalled();
  });

  it("does not open a late answer for a link that is no longer wanted", async () => {
    const open = vi.fn();
    const outcome = await openDeepLinked({
      wanted: older.id,
      records: newestHundred,
      open,
      resolve: async () => older,
      stillWanted: () => false,
      scrollTo: () => {},
    });
    expect(outcome).toBe("none");
    expect(open).not.toHaveBeenCalled();
  });
});
