/**
 * Why the obvious suspect is not the cause.
 *
 * The tempting explanation for a column stuck on the wrong language is a
 * race: first paint renders the default, the mount effect persists THAT,
 * the client then flips to the real locale and persists again, and two
 * unordered `keepalive` PUTs land in the wrong order. It would explain the
 * symptom exactly, and it would mean the write needs ordering.
 *
 * It is not what happens. The provider takes the locale the SERVER already
 * resolved — cookie, then column, then Accept-Language — and nothing on the
 * mount path changes it afterwards, so the effect fires once, with the right
 * value, and there is no second write to race with. The write is lost a
 * simpler way: it is fire-and-forget, so a 401 on the paint before sign-in,
 * an offline blip or a tab closed mid-flight drops it, and the next mount
 * repeats the same unreliable attempt rather than noticing.
 *
 * These pin the two properties that rule the race out, so that a future
 * change which does introduce a mount-time flip has to face this file.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider, useTranslations } from "@/lib/i18n/context";
import deMessages from "../../../../messages/de.json";

function Read({ k }: { k: string }) {
  const { t } = useTranslations();
  return <span>{t(k)}</span>;
}

describe("first paint carries the resolved locale, not a default", () => {
  it("renders the server-resolved locale on the very first pass", () => {
    // If this ever rendered English first, the mount effect would persist
    // English before the flip, and the race above would be real.
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="de" initialMessages={deMessages}>
        <Read k="common.save" />
      </I18nProvider>,
    );
    expect(html).toContain("Speichern");
    expect(html).not.toContain(">Save<");
  });

  it("changes the active locale only through the switcher", () => {
    const src = readFileSync(
      join(process.cwd(), "src/lib/i18n/context.tsx"),
      "utf8",
    );
    expect(src.length).toBeGreaterThan(0);

    // Every `setActive` call in the file. One belongs to `setLocale` (the
    // explicit switch); the others are the bundle backfill, which must
    // carry the locale it was given and never a different one.
    const setActiveCalls = src.match(/setActive\(/g) ?? [];
    expect(setActiveCalls.length).toBeGreaterThan(0);

    // The backfill keeps `prev` whenever the locale moved under it, so it
    // can only ever swap MESSAGES, never the locale.
    expect(src).toMatch(
      /prev\.locale === locale \? \{ locale, messages: loaded \} : prev/,
    );

    // And the provider writes nothing to the server itself: the mirror lives
    // in `LocaleServerSyncBridge`, keyed on the locale and the signed-in
    // account, so a signed-out mount sends nothing and one account with one
    // locale means one write (its browser test pins both).
    expect(src).toMatch(/export function persistLocaleToServer\(/);
    expect(src).not.toMatch(/persistLocaleToServer\(locale/);
  });
});
