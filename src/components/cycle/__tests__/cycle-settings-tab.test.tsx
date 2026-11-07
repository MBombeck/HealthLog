import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const caps = vi.hoisted(() => ({
  value: { inSharedRecord: false, recordKind: "self", level: null } as {
    inSharedRecord: boolean;
    recordKind: string;
    level: string | null;
  },
}));
vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => caps.value,
}));
vi.mock("../cycle-settings", () => ({
  CycleSettings: () => <div data-slot="cycle-settings-form" />,
}));
vi.mock("../cycle-calendar-feed-card", () => ({
  CycleCalendarFeedCard: () => <div data-slot="cycle-calendar-feed" />,
}));

import { CycleSettingsTab } from "../cycle-settings-tab";
import type { CycleProfileDTO } from "../types";

const PROFILE = { updatedAt: "2026-11-01T00:00:00.000Z" } as CycleProfileDTO;

function render(value: typeof caps.value) {
  caps.value = value;
  return renderToStaticMarkup(<CycleSettingsTab profile={PROFILE} />);
}

describe("<CycleSettingsTab> calendar subscription (#1350)", () => {
  it("offers it on one's own record", () => {
    expect(
      render({ inSharedRecord: false, recordKind: "self", level: null }),
    ).toContain("cycle-calendar-feed");
  });

  it("offers it to the guardian of a managed profile", () => {
    expect(
      render({ inSharedRecord: true, recordKind: "managed", level: "manage" }),
    ).toContain("cycle-calendar-feed");
  });

  it("does not offer it to a MANAGE delegate on an adult's record", () => {
    const html = render({
      inSharedRecord: true,
      recordKind: "shared",
      level: "manage",
    });
    expect(html).toContain("cycle-settings-form");
    expect(html).not.toContain("cycle-calendar-feed");
  });
});
