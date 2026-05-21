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
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { OfflineBanner } from "../offline-banner";

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
    // The copy itself is module-private (only painted client-side),
    // so we verify the message exists in the i18n bundle.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const en = require("../../../../messages/en.json") as {
      offlineBanner: { message: string };
    };
    expect(en.offlineBanner.message).toBe(
      "No connection — your changes will save once you're back online.",
    );
  });

  it("ships the DE copy for `offlineBanner.message`", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const de = require("../../../../messages/de.json") as {
      offlineBanner: { message: string };
    };
    expect(de.offlineBanner.message).toBe(
      "Keine Verbindung — Änderungen werden gespeichert, sobald du wieder online bist.",
    );
  });

  it("ships the message key in every supported locale", () => {
    for (const locale of ["en", "de", "fr", "es", "it", "pl"] as const) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require(`../../../../messages/${locale}.json`) as {
        offlineBanner?: { message?: string };
      };
      expect(m.offlineBanner?.message?.length, locale).toBeGreaterThan(0);
    }
  });

  it("mounts in auth-shell.tsx above the maintainership banner", () => {
    // Pin the wiring at the file level so a future refactor that
    // removes the import / mount accidentally is caught.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const shellPath = path.join(
      __dirname,
      "..",
      "auth-shell.tsx",
    );
    const source = fs.readFileSync(shellPath, "utf8");
    expect(source).toContain('from "./offline-banner"');
    expect(source).toContain("<OfflineBanner />");
  });
});

// v1.4.43 QoL (M5) — also pin the client-side branch: when
// `isOnline === false` the banner paints with the i18n message,
// the WifiOff icon, and the `role="status"` aria-live region. We
// can't easily fire window events from a node-environment vitest
// suite, but we can compile the component source and assert the
// branch carries the expected affordances.
describe("<OfflineBanner> rendered branch (source-level)", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require("node:path") as typeof import("node:path");
  const source = fs.readFileSync(
    path.join(__dirname, "..", "offline-banner.tsx"),
    "utf8",
  );

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
