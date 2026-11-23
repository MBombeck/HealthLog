import { describe, it, expect } from "vitest";

import {
  determinePhase,
  getPhaseKeyboard,
  openingPhase,
  getPhaseMessage,
  resolvePhaseThresholds,
  DEFAULT_PHASE_CONFIG,
} from "../reminder-phases";

describe("determinePhase", () => {
  const thresholds = resolvePhaseThresholds(DEFAULT_PHASE_CONFIG, 60);

  it("returns RED past the red threshold", () => {
    expect(determinePhase(-300, 360, thresholds)).toBe("RED");
  });

  it("returns ORANGE between window end and red", () => {
    expect(determinePhase(-30, 90, thresholds)).toBe("ORANGE");
  });

  it("returns YELLOW within yellowMinBefore of window end", () => {
    expect(determinePhase(20, 40, thresholds)).toBe("YELLOW");
  });

  it("returns GREEN inside green window when at/after window start", () => {
    expect(determinePhase(50, 10, thresholds)).toBe("GREEN");
  });

  it("returns null before window start", () => {
    expect(determinePhase(80, -20, thresholds)).toBe(null);
  });
});

// v1.4: closes the "Locale Mixing" finding.
// Reminder messages must follow the user's stored locale, not always
// German. callback_data values are stable English identifiers and stay
// untranslated regardless of UI locale.
describe("getPhaseMessage — localised", () => {
  it("uses German message + title for de locale", () => {
    const result = getPhaseMessage(
      "GREEN",
      "Ramipril",
      "10mg",
      "08:00–09:00",
      45,
      "de",
    );
    expect(result.title).toBe("🟢 Fällig: Ramipril");
    expect(result.message).toContain("Das Zeitfenster endet in 45 Min.");
    expect(result.message).toContain("<b>Ramipril</b>");
  });

  it("uses English message + title for en locale", () => {
    const result = getPhaseMessage(
      "YELLOW",
      "Ramipril",
      "10mg",
      "08:00–09:00",
      20,
      "en",
    );
    expect(result.title).toBe("🟡 Still due: Ramipril");
    expect(result.message).toContain("20 min left in the window.");
    expect(result.message).toContain("<b>Ramipril</b>");
  });

  it("falls back to default locale (en) for unknown / missing locale", () => {
    const result = getPhaseMessage(
      "ORANGE",
      "Aspirin",
      "100mg",
      "12:00–13:00",
      -90,
      null,
    );
    expect(result.title).toBe("🟠 Overdue: Aspirin");
    expect(result.message).toContain("Overdue by 90 min.");
  });

  it("RED phase template suppresses the per-message minutes count", () => {
    const result = getPhaseMessage(
      "RED",
      "Aspirin",
      "100mg",
      "12:00–13:00",
      -300,
      "en",
    );
    // Missed, and a late take still counts: the message says both.
    expect(result.title).toBe("🔴 Missed: Aspirin");
    expect(result.message).toContain("still counts, as late");
    expect(result.message).not.toContain("300");
  });
});

describe("getPhaseKeyboard — localised", () => {
  it("returns German labels for de locale", () => {
    const kb = getPhaseKeyboard("YELLOW", "med-1", "de");
    const flat = kb.inline_keyboard.flat();
    expect(flat.find((b) => b.callback_data === "taken:med-1")?.text).toBe(
      "✅ Einnehmen",
    );
    // One snooze, the person's own length (default 30 min), named in the
    // label like on every other surface.
    expect(flat.find((b) => b.callback_data === "snooze:med-1:30")?.text).toBe(
      "🕐 Später erinnern (30 Min.)",
    );
    expect(flat.find((b) => b.callback_data === "skip:med-1")?.text).toBe(
      "⏭ Überspringen",
    );
  });

  it("returns English labels for en locale", () => {
    const kb = getPhaseKeyboard("YELLOW", "med-1", "en");
    const flat = kb.inline_keyboard.flat();
    expect(flat.find((b) => b.callback_data === "taken:med-1")?.text).toBe(
      "✅ Take",
    );
    expect(flat.find((b) => b.callback_data === "skip:med-1")?.text).toBe(
      "⏭ Skip",
    );
  });

  it("RED phase offers a late take and leaving the dose missed, localised", () => {
    const en = getPhaseKeyboard("RED", "med-1", "en").inline_keyboard[0];
    expect(en.find((b) => b.callback_data === "ack:med-1")?.text).toBe(
      "Leave as missed",
    );
    expect(en.find((b) => b.callback_data === "taken:med-1")?.text).toBe(
      "✅ Take (counts as late)",
    );
    expect(
      getPhaseKeyboard("RED", "med-1", "de").inline_keyboard[0].find(
        (b) => b.callback_data === "ack:med-1",
      )?.text,
    ).toBe("Als verpasst lassen");
  });

  it("callback_data values are NEVER translated (stable contract)", () => {
    for (const locale of ["de", "en", null, "fr"] as const) {
      const kb = getPhaseKeyboard("YELLOW", "med-x", locale);
      const cb = kb.inline_keyboard.flat().map((b) => b.callback_data);
      expect(cb).toContain("taken:med-x");
      expect(cb).toContain("snooze:med-x:30");
      expect(cb).toContain("skip:med-x");
    }
  });
});

describe("getPhaseKeyboard — the person's snooze length", () => {
  it("offers exactly one snooze, with the length the setting holds", () => {
    const flat = getPhaseKeyboard(
      "GREEN",
      "med-1",
      "en",
      45,
    ).inline_keyboard.flat();
    const snoozes = flat.filter((b) => b.callback_data.startsWith("snooze:"));
    expect(snoozes).toEqual([
      { text: "🕐 Remind me later (45 min)", callback_data: "snooze:med-1:45" },
    ]);
  });
});

describe("openingPhase", () => {
  it("is GREEN for a window longer than the YELLOW lead", () => {
    const t = resolvePhaseThresholds(DEFAULT_PHASE_CONFIG, 120);
    expect(openingPhase(t, 120)).toBe("GREEN");
  });

  it("is YELLOW for a point slot, which never shows GREEN", () => {
    const t = resolvePhaseThresholds(DEFAULT_PHASE_CONFIG, 0);
    expect(openingPhase(t, 0)).toBe("YELLOW");
    // The same window walked tick by tick reaches YELLOW before anything else.
    expect(determinePhase(30, -30, t)).toBe("YELLOW");
    expect(determinePhase(45, -45, t)).toBeNull();
  });

  it("is YELLOW when the GREEN lead is not longer than the YELLOW lead", () => {
    const t = resolvePhaseThresholds(
      { ...DEFAULT_PHASE_CONFIG, greenValue: 20, yellowValue: 30 },
      120,
    );
    expect(openingPhase(t, 120)).toBe("YELLOW");
  });
});
