/**
 * The window filter keeps a medication whole: when one of its items touches
 * the window, every item of it is sent, because the client reads the
 * stretches from its courses and the dose of a piece from the last dose
 * change before it, which may lie outside the window.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import type { TimelineItem } from "@/lib/day/contract";

import { keepTouchingGroups } from "../load-timeline";

const base = {
  end: null,
  open: false,
  precision: "DAY" as const,
  startKnown: true,
  sub: null,
  href: null,
};
const entry = (
  over: Partial<TimelineItem> & Pick<TimelineItem, "id" | "kind" | "start">,
): TimelineItem =>
  ({ ...base, label: over.id, group: null, ...over }) as TimelineItem;

describe("keepTouchingGroups", () => {
  const items = [
    entry({
      id: "mj",
      group: "mj",
      kind: "medication",
      start: "2024-01-01",
      open: true,
    }),
    entry({
      id: "c1",
      group: "mj",
      kind: "course",
      start: "2024-01-01",
      end: "2024-06-30",
    }),
    entry({
      id: "c2",
      group: "mj",
      kind: "course",
      start: "2026-01-01",
      open: true,
    }),
    entry({
      id: "d1",
      group: "mj",
      kind: "doseChange",
      start: "2024-01-01",
      sub: "2.5 mg",
    }),
    entry({
      id: "old",
      group: "old",
      kind: "medication",
      start: "2020-01-01",
      end: "2020-03-01",
    }),
    entry({ id: "v1", kind: "vaccination", start: "2023-05-01" }),
  ];

  it("sends every item of a medication that touches the window", () => {
    const kept = keepTouchingGroups(
      items,
      "2026-07-01",
      "2026-10-09",
      "2026-10-09",
    );
    expect(kept.map((i) => i.id).sort()).toEqual(["c1", "c2", "d1", "mj"]);
  });

  it("leaves out a group and a lone item that do not touch it", () => {
    const kept = keepTouchingGroups(
      items,
      "2026-07-01",
      "2026-10-09",
      "2026-10-09",
    );
    expect(kept.some((i) => i.id === "old" || i.id === "v1")).toBe(false);
  });
});
