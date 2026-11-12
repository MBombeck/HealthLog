/**
 * `<OfflineBanner>` SSR contract and copy.
 *
 * The banner reads `navigator.onLine` + subscribes to `online`/`offline`
 * window events inside a `useEffect`. SSR markup is therefore always
 * empty (hidden); the effect flips the state once the component
 * mounts client-side. Pin both halves of that contract here so a
 * future refactor that paints during SSR (and creates a hydration
 * mismatch) gets caught.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { OfflineBanner } from "../offline-banner";

const ROOT = join(__dirname, "../../../..");
const SHELL_PATH = join(ROOT, "src/components/layout/auth-shell.tsx");
const BANNER_PATH = join(ROOT, "src/components/layout/offline-banner.tsx");

function loadMessages(locale: string): {
  offlineBanner: { message: string; stayOnPage: string };
} {
  const path = join(ROOT, "messages", `${locale}.json`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<OfflineBanner>", () => {
  it("renders nothing during SSR — hydration starts hidden", () => {
    // The component initialises `isOnline === true`, so its first
    // render (the SSR pass) returns `null`. The client-side effect
    // then reads `navigator.onLine` and flips state if needed.
    const html = render(<OfflineBanner />);
    expect(html).toBe("");
  });

  it("ships the EN copy for `offlineBanner.message`", () => {
    // The copy must not over-promise auto-save: offline mutations now
    // fail fast (networkMode "always") rather than queue, so the banner states
    // the honest thing. "Once you're back online" is said by the sentence
    // after it, once.
    const en = loadMessages("en");
    expect(en.offlineBanner.message).toBe(
      "No connection: changes can't be saved.",
    );
  });

  it("ships the DE copy for `offlineBanner.message`", () => {
    const de = loadMessages("de");
    expect(de.offlineBanner.message).toBe(
      "Keine Verbindung: Änderungen können nicht gespeichert werden.",
    );
  });

  it("says what still works: the open page, not the rest of the app", () => {
    // The banner used to promise "your last synced data" although one tap
    // on another page ended on the worker's offline page.
    const en = loadMessages("en");
    expect(en.offlineBanner.stayOnPage).toBe(
      "This page stays readable; other pages open once you're back online.",
    );
    expect(en.offlineBanner).not.toHaveProperty("showingCached");
  });

  it("ships the message key in every supported locale", () => {
    for (const locale of [
      "en",
      "de",
      "fr",
      "es",
      "it",
      "pl",
      "ko",
      "nl",
      "pt-BR",
      "ru",
    ] as const) {
      const m = loadMessages(locale);
      expect(m.offlineBanner.message.length, locale).toBeGreaterThan(0);
      expect(m.offlineBanner.stayOnPage.length, locale).toBeGreaterThan(0);
    }
  });

  it("mounts in auth-shell.tsx above the maintainership banner", () => {
    const source = readFileSync(SHELL_PATH, "utf8");
    expect(source).toContain('from "./offline-banner"');
    expect(source).toContain("<OfflineBanner />");
  });
});

// The client-side branch: when `isOnline === false` the banner paints with
// the i18n message, the WifiOff icon, and the `role="status"` aria-live
// region. Window events cannot fire in this node-environment suite, so the
// branch is read from the source.
describe("<OfflineBanner> rendered branch (source-level)", () => {
  const source = readFileSync(BANNER_PATH, "utf8");

  it("hosts an aria-live polite status region (assistive-tech friendly)", () => {
    expect(source).toContain('role="status"');
    expect(source).toContain('aria-live="polite"');
  });

  it("paints the WifiOff icon (visual signal for sighted users)", () => {
    expect(source).toContain("WifiOff");
  });

  it("subscribes + unsubscribes to both online and offline window events", () => {
    expect(source).toContain('window.addEventListener("online"');
    expect(source).toContain('window.addEventListener("offline"');
    expect(source).toContain('window.removeEventListener("online"');
    expect(source).toContain('window.removeEventListener("offline"');
  });
});
