/**
 * v1.41 — the Coach's thinking depth: Off / Low / Medium / High, rendered
 * from what the server resolved, never recomputed.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { getServerTranslator } from "@/lib/i18n/server-translator";

const locale = vi.hoisted(() => ({ current: "en" as "en" | "de" }));
vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      getServerTranslator(locale.current).t(key, params),
  }),
}));

import {
  CoachReasoningSelect,
  reasoningLocked,
  reasoningOptions,
  reasoningStateOrDefault,
  shownReasoningLevel,
  type CoachReasoningState,
} from "../coach-reasoning-field";

const OPEN: CoachReasoningState = {
  level: "medium",
  preference: "medium",
  maxLevel: "high",
  available: true,
  offIsReal: true,
  source: "user",
};
const ADMIN_OFF: CoachReasoningState = {
  level: "off",
  preference: "high",
  maxLevel: "off",
  available: false,
  offIsReal: true,
  source: "admin_off",
};

function render(state: CoachReasoningState, value = state.level) {
  return renderToStaticMarkup(
    <CoachReasoningSelect
      id="r"
      value={value}
      state={state}
      onChange={() => {}}
    />,
  );
}

describe("the resolved block", () => {
  it("reads an older server's missing block as allowed, uncapped, really off", () => {
    expect(reasoningStateOrDefault(null)).toEqual(OPEN);
    expect(reasoningStateOrDefault(undefined)).toEqual(OPEN);
  });

  it("is locked only when the operator switched reasoning off", () => {
    expect(reasoningLocked(ADMIN_OFF)).toBe(true);
    expect(reasoningLocked(OPEN)).toBe(false);
    // A provider that cannot reason does not lock the person's choice.
    expect(
      reasoningLocked({ ...OPEN, available: false, source: "unsupported" }),
    ).toBe(false);
  });
});

describe("<CoachReasoningSelect>", () => {
  it("offers Off, Low, Medium and High with the label and hint", () => {
    const html = render(OPEN);
    expect(html).toContain(">Thinking depth<");
    for (const label of ["Off", "Low", "Medium", "High"]) {
      expect(html).toContain(`>${label}</option>`);
    }
    expect(html).toContain(
      "Deeper thinking means more precise answers and a little more waiting.",
    );
    expect(html).not.toMatch(/<select[^>]*\sdisabled=""/);
  });

  it("is locked with one sentence when the admin turned reasoning off", () => {
    const html = render(ADMIN_OFF, "high");
    expect(html).toMatch(/<select[^>]*\sdisabled=""/);
    expect(html).toContain('data-locked="true"');
    expect(html).toContain("The admin has turned deeper thinking off.");
    expect(html).not.toContain("a little more waiting");
  });

  it("shows the admin's cap: levels above it are disabled and say why", () => {
    const html = render({ ...OPEN, maxLevel: "medium" });
    expect(html).toMatch(
      /<option value="high" disabled="">High \(limited by the admin\)<\/option>/,
    );
    expect(html).toMatch(
      /<option value="medium"( selected="")?>Medium<\/option>/,
    );
  });

  it("says Minimal where the provider cannot switch thinking off", () => {
    const options = reasoningOptions(
      { ...OPEN, offIsReal: false },
      getServerTranslator("en").t,
    );
    expect(options[0]).toEqual({
      value: "off",
      label: "Minimal",
      disabled: false,
    });
  });

  it("shows a choice above the cap at the cap, which is what runs", () => {
    expect(shownReasoningLevel("high", { ...OPEN, maxLevel: "low" })).toBe(
      "low",
    );
    expect(shownReasoningLevel("low", OPEN)).toBe("low");
    expect(shownReasoningLevel("high", ADMIN_OFF)).toBe("off");
  });

  it("reads in German", () => {
    locale.current = "de";
    const html = render({ ...OPEN, maxLevel: "low" });
    locale.current = "en";
    expect(html).toContain(">Denktiefe<");
    expect(html).toContain("Hoch (vom Admin begrenzt)");
  });
});

describe("the two homes of the field", () => {
  const selectClass = (html: string) =>
    html.match(/<select[^>]*class="([^"]*)"/)?.[1] ?? "";

  it("stacks as wide as the quick settings sheet", () => {
    const html = render(OPEN);
    expect(html).toContain('data-no-colon="true"');
    expect(selectClass(html)).toMatch(/\bw-full\b/);
    expect(selectClass(html)).toMatch(/\bmt-1\b/);
  });

  it("takes the shape of Tone and Reply length in Settings → Coach", () => {
    const html = renderToStaticMarkup(
      <CoachReasoningSelect
        id="r"
        variant="card"
        value="medium"
        state={OPEN}
        onChange={() => {}}
      />,
    );
    // Their small label with its colon, a content-wide select, the card's
    // own gap instead of margins.
    expect(html).toMatch(/data-slot="coach-reasoning-field" class="[^"]*gap-2/);
    expect(html).toContain('data-no-colon="false"');
    expect(html).toMatch(/<label[^>]*class="[^"]*\btext-xs\b/);
    expect(selectClass(html)).toMatch(/\bw-fit\b/);
    expect(selectClass(html)).not.toMatch(/\bw-full\b|\bmt-1\b/);
  });

  it("looks locked when the operator switched reasoning off", () => {
    const html = render(ADMIN_OFF);
    expect(html).toMatch(/<select[^>]*\sdisabled=""/);
    expect(selectClass(html)).toContain("disabled:opacity-50");
  });
});
