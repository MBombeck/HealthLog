import { describe, expect, it } from "vitest";

import { formatMessage, hasPluralBlock } from "../format-message";
import { getServerTranslator } from "../server-translator";

const DEVICES =
  "{count, plural, one {# device bound} other {# devices bound}} to {name}";
const RU_DAYS =
  "{count, plural, one {# день} few {# дня} many {# дней} other {# дня}}";

describe("formatMessage", () => {
  it("picks the CLDR branch for the locale", () => {
    expect(formatMessage(DEVICES, { count: 1, name: "A" }, "en")).toBe(
      "1 device bound to A",
    );
    expect(formatMessage(DEVICES, { count: 2, name: "A" }, "en")).toBe(
      "2 devices bound to A",
    );
    expect(formatMessage(RU_DAYS, { count: 1 }, "ru")).toBe("1 день");
    expect(formatMessage(RU_DAYS, { count: 3 }, "ru")).toBe("3 дня");
    expect(formatMessage(RU_DAYS, { count: 5 }, "ru")).toBe("5 дней");
    expect(formatMessage(RU_DAYS, { count: 21 }, "ru")).toBe("21 день");
    expect(formatMessage(RU_DAYS, { count: 22 }, "ru")).toBe("22 дня");
  });

  it("prefers an exact selector and falls back to other", () => {
    const tpl = "{count, plural, =0 {none} one {one} other {# many}}";
    expect(formatMessage(tpl, { count: 0 }, "en")).toBe("none");
    expect(formatMessage(tpl, { count: 7 }, "ko")).toBe("7 many");
  });

  it("reads a formatted count string as its integer", () => {
    const tpl = "{count, plural, one {# entry} other {# entries}}";
    expect(formatMessage(tpl, { count: "1" }, "en")).toBe("1 entry");
    expect(formatMessage(tpl, { count: "1,234" }, "en")).toBe("1,234 entries");
  });

  it("substitutes values literally and never re-reads them", () => {
    const tpl = "{name} opened {count, plural, one {once} other {# times}}";
    expect(formatMessage(tpl, { name: "{count} $' #", count: 1 }, "en")).toBe(
      "{count} $' # opened once",
    );
  });

  it("leaves a template untouched without the plural parameter", () => {
    expect(formatMessage(DEVICES, { name: "A" }, "en")).toBe(
      "{count, plural, one {# device bound} other {# devices bound}} to A",
    );
    expect(formatMessage("{a} and {b}", { a: 1 }, "en")).toBe("1 and {b}");
  });

  it("detects a plural block", () => {
    expect(hasPluralBlock(DEVICES)).toBe(true);
    expect(hasPluralBlock("{count} devices")).toBe(false);
  });

  it("is what the server translator renders", () => {
    // A real converted key: the relay card's device count.
    const { t } = getServerTranslator("en");
    expect(t("admin.pushRelay.devices", { count: 1 })).not.toMatch(/1 devices/);
  });
});
