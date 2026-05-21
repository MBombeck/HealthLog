/**
 * v1.4.43 QoL (M5) — `<OfflineBanner>` SSR contract.
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

function loadMessages(locale: string): { offlineBanner: { message: string } } {
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
    const en = loadMessages("en");
    expect(en.offlineBanner.message).toBe(
      "No connection — your changes will save once you're back online.",
    );
  });

  it("ships the DE copy for `offlineBanner.message`", () => {
    const de = loadMessages("de");
    expect(de.offlineBanner.message).toBe(
      "Keine Verbindung — Änderungen werden gespeichert, sobald du wieder online bist.",
    );
  });

  it("ships the message key in every supported locale", () => {
    for (const locale of ["en", "de", "fr", "es", "it", "pl"] as const) {
      const m = loadMessages(locale);
      expect(m.offlineBanner.message.length, locale).toBeGreaterThan(0);
    }
  });

  it("mounts in auth-shell.tsx above the maintainership banner", () => {
    const source = readFileSync(SHELL_PATH, "utf8");
    expect(source).toContain('from "./offline-banner"');
    expect(source).toContain("<OfflineBanner />");
  });
});

// v1.4.43 QoL (M5) — also pin the client-side branch: when
// `isOnline === false` the banner paints with the i18n message,
// the WifiOff icon, and the `role="status"` aria-live region. We
// can't easily fire window events from a node-environment vitest
// suite, but we can read the component source and assert the
// branch carries the expected affordances.
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
