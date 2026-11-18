import { describe, expect, it } from "vitest";

import { boundedReferences } from "../bounded-references";

describe("boundedReferences", () => {
  it("keeps references up to the cap and counts the rest", () => {
    const list = boundedReferences<number>(3);
    for (let i = 0; i < 1_000; i += 1) list.push(i);
    expect(list.items).toEqual([0, 1, 2]);
    expect(list.overflow).toBe(997);
    expect(list.total).toBe(1_000);
    expect(list.handOver()).toEqual({ references: [0, 1, 2], overflow: 997 });
  });

  it("forgets both once the pass has read them", () => {
    const list = boundedReferences<string>(2);
    list.push("a");
    list.push("b");
    list.push("c");
    list.clear();
    expect(list.items).toEqual([]);
    expect(list.overflow).toBe(0);
    expect(list.total).toBe(0);
  });
});
