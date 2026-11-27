import { describe, expect, it } from "vitest";

import {
  DISMISSED_HINTS_MAX,
  isDismissibleHintId,
  nextDismissedHints,
} from "../dismissible-hints";
import { isHintDismissed } from "@/hooks/use-dismissed-hints";

describe("dismissible hint ids", () => {
  it("accepts a family and a family member", () => {
    expect(isDismissibleHintId("timeline-readiness")).toBe(true);
    expect(isDismissibleHintId("i18n-banner.pt-BR")).toBe(true);
    expect(isDismissibleHintId("getting-started.extra:visit")).toBe(true);
  });

  it("refuses anything else", () => {
    expect(isDismissibleHintId("")).toBe(false);
    expect(isDismissibleHintId("nope")).toBe(false);
    expect(isDismissibleHintId("ai-setup.")).toBe(false);
    expect(isDismissibleHintId("ai-setup.a b")).toBe(false);
    expect(isDismissibleHintId(`ai-setup.${"x".repeat(65)}`)).toBe(false);
  });
});

describe("nextDismissedHints", () => {
  it("adds once, newest last", () => {
    expect(
      nextDismissedHints(["ai-setup"], {
        dismiss: ["ai-setup", "i18n-banner.fr"],
      }),
    ).toEqual(["ai-setup", "i18n-banner.fr"]);
  });

  it("restores a family with its members", () => {
    expect(
      nextDismissedHints(
        ["getting-started", "getting-started.profile", "getting-started-x"],
        { restore: ["getting-started"] },
      ),
    ).toEqual(["getting-started-x"]);
  });

  it("keeps at most the newest DISMISSED_HINTS_MAX", () => {
    const many = Array.from(
      { length: DISMISSED_HINTS_MAX },
      (_, i) => `getting-started.r${i}`,
    );
    const next = nextDismissedHints(many, { dismiss: ["ai-setup"] });
    expect(next).toHaveLength(DISMISSED_HINTS_MAX);
    expect(next.at(-1)).toBe("ai-setup");
  });
});

describe("isHintDismissed", () => {
  it("a closed family closes its members", () => {
    expect(isHintDismissed(["i18n-banner"], "i18n-banner.fr")).toBe(true);
    expect(isHintDismissed(["i18n-banner.fr"], "i18n-banner.it")).toBe(false);
    expect(isHintDismissed(["i18n-banner.fr"], "i18n-banner")).toBe(false);
  });
});
