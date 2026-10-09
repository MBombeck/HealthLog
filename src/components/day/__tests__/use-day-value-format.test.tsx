import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import deMessages from "../../../../messages/de.json";
import enMessages from "../../../../messages/en.json";

/**
 * A day's values read as their charts read them. The day route sends a
 * night's length in "min" and a device score in "score"; the first read as a
 * bare 412 and the second as an untranslated "score" before both were
 * spelled the way the sleep and recovery charts spell them.
 */

vi.mock("@/hooks/use-unit-display", async () => {
  const { unitDisplayFor } =
    await import("@/__tests__/helpers/unit-display-mock");
  return { useUnitDisplay: () => unitDisplayFor("metric") };
});

import { I18nProvider } from "@/lib/i18n/context";

import { useDayValueFormat } from "../use-day-value-format";

function Probe({
  type,
  value,
  unit,
}: {
  type: string;
  value: number;
  unit: string;
}) {
  const { formatTile } = useDayValueFormat();
  const shown = formatTile({
    key: type,
    values: [{ type, value, unit, at: "", source: "", band: null }],
    readings: 1,
  });
  return (
    <span>
      {shown.value}|{shown.unit}
    </span>
  );
}

/**
 * The text of rendered markup: every character outside a `<…>` tag. A walk
 * rather than a tag-stripping regex, which can leave a tag behind when one
 * is split across another.
 */
function textOf(html: string): string {
  let out = "";
  let inTag = false;
  for (const ch of html) {
    if (ch === "<") inTag = true;
    else if (ch === ">") inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
}

function read(
  type: string,
  value: number,
  unit: string,
  locale: "en" | "de" = "en",
) {
  return textOf(
    renderToStaticMarkup(
      <I18nProvider
        initialLocale={locale}
        initialMessages={locale === "de" ? deMessages : enMessages}
      >
        <Probe type={type} value={value} unit={unit} />
      </I18nProvider>,
    ),
  );
}

describe("a day's values in their charts' spelling", () => {
  it("reads a night sent in min as a duration", () => {
    const [value, unit] = read("SLEEP_DURATION", 412, "min").split("|");
    expect(value).toMatch(/6\s*h/);
    expect(value).toMatch(/52/);
    expect(unit).toBe("");
  });

  it("reads a device score in the reader's word for points", () => {
    // German, where the wire's "score" and the chart's "Punkte" differ.
    const [value, unit] = read("ANS_CHARGE", 8, "score", "de").split("|");
    expect(value).toBe("8");
    expect(unit).toBe("Punkte");
  });
});
