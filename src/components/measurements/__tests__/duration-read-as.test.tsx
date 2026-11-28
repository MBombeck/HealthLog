import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { parseDurationEntry } from "@/lib/measurements/parse-duration";
import { DurationReadAs } from "../duration-read-as";
import { primeLocales } from "@/__tests__/helpers/prime-locales";

primeLocales("de", "ko");

/**
 * The hint under a duration field says how the entry was read, so "7.5",
 * "7:30" and "7h30" can each be checked before saving.
 */
function render(minutes: number, locale: "en" | "de" | "ko" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <DurationReadAs minutes={minutes} />
    </I18nProvider>,
  );
}

function readAs(raw: string): string {
  const read = parseDurationEntry(raw, "h");
  if (!read.ok) throw new Error(`refused ${raw}`);
  return render(read.minutes);
}

describe("<DurationReadAs>", () => {
  it.each(["7.5", "7,5", "7:30", "7h30", "7 h 30 min"])(
    "shows %j as seven and a half hours",
    (raw) => {
      expect(readAs(raw)).toContain("Read as 7 h 30 min");
    },
  );

  it("leaves out a zero part", () => {
    expect(render(480)).toContain("Read as 8 h<");
    expect(render(45)).toContain("Read as 45 min");
  });

  it("speaks the reader's language", () => {
    expect(render(450, "de")).toContain("7 Std. 30 Min.");
    expect(render(450, "ko")).toContain("7시간 30분");
  });

  it("is wired under the measurement form's value field", () => {
    const form = readFileSync(
      join(process.cwd(), "src/components/measurements/measurement-form.tsx"),
      "utf8",
    );
    expect(form).toMatch(
      /valueHint=\{\s*durationRead\?\.ok === true \? \(\s*<DurationReadAs minutes=\{durationRead\.minutes\} \/>/,
    );
    // A refused entry is an inline field error, never a toast.
    expect(form).toMatch(/setValueError\(\s*t\(/);
  });
});
