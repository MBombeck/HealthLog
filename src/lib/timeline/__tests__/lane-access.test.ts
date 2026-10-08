/**
 * v1.42 — the `life` lane (life events, travel periods) is the owner's only.
 * No share level reaches it: not `profile`, not a whole-record share.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import { laneVisible, type TimelineAccess } from "../lanes";

const modules = { timeline: true } as unknown as TimelineAccess["modules"];

describe("the life lane", () => {
  it("is hidden from a delegate whatever the grant covers", () => {
    const delegate: TimelineAccess = {
      modules,
      domainVisible: () => true,
      owner: false,
    };
    expect(laneVisible("life", delegate)).toBe(false);
    expect(laneVisible("allergies", delegate)).toBe(true);
  });

  it("is shown to the owner", () => {
    expect(
      laneVisible("life", { modules, domainVisible: () => true, owner: true }),
    ).toBe(true);
  });
});
