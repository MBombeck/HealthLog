import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * F-7 (mobile security audit, 2026-05-16): three regressions to lock
 * in for `public/sw.js`.
 *
 *   - `notificationclick` validates the destination resolves to the
 *     same origin before calling `client.navigate()` — VAPID auth on
 *     push payloads only proves authenticity, not that the URL is
 *     safe to navigate to. A compromised admin issuing pushes could
 *     otherwise drive a focused PWA at an off-origin URL.
 *   - The offline fallback HTML is no longer hard-coded German body
 *     copy. The replacement renders a language-neutral icon +
 *     "Offline" wordmark.
 *   - The manifest carries `scope`, `id`, and `display_override` so
 *     PWA install identity and scope are explicit instead of
 *     defaulting on the user-agent's behalf.
 *
 * The service worker depends on `self`, `caches`, `clients`, and other
 * worker-globals that aren't available in node, so this suite reads
 * `public/sw.js` as text and asserts on the source rather than
 * executing the worker. Cheap and stable across worker-runtime drift.
 */

const SW_PATH = resolve(process.cwd(), "public/sw.js");
const MANIFEST_PATH = resolve(process.cwd(), "public/manifest.json");

function readSw(): string {
  return readFileSync(SW_PATH, "utf-8");
}

describe("public/sw.js notificationclick same-origin guard (F-7, 2026-05-16)", () => {
  it("validates the navigation URL resolves to the worker's own origin", () => {
    const sw = readSw();
    // The guard reads `data.url`, parses it with `new URL(rawUrl,
    // self.location.origin)`, and only navigates when
    // `resolved.origin === self.location.origin`. Each substring is
    // independently load-bearing.
    expect(sw).toMatch(/new URL\(rawUrl, self\.location\.origin\)/);
    expect(sw).toMatch(/resolved\.origin === self\.location\.origin/);
  });

  it("falls back to `/` for off-origin or malformed payloads", () => {
    const sw = readSw();
    // Two fallback paths — the URL parse failure (try/catch) and the
    // origin mismatch branch. Both must end at `safeUrl = "/"`.
    const safeUrlAssignments = sw.match(/safeUrl\s*=\s*"\/"/g) ?? [];
    expect(safeUrlAssignments.length).toBeGreaterThanOrEqual(2);
  });

  it("never calls client.navigate with the raw payload URL", () => {
    const sw = readSw();
    // The previous code called `client.navigate(url)` directly. The
    // hardened version only ever navigates the sanitised `safeUrl`.
    expect(sw).not.toMatch(/client\.navigate\(url\)/);
    expect(sw).toMatch(/client\.navigate\(safeUrl\)/);
    expect(sw).toMatch(/self\.clients\.openWindow\(safeUrl\)/);
  });
});

describe("public/sw.js offline fallback locale neutrality (F-7, 2026-05-16)", () => {
  it("does not embed hard-coded German body copy in the offline page", () => {
    const sw = readSw();
    // Previous fallback shipped a German sentence. The replacement is
    // language-neutral — wordmark + "Offline" token + an icon. None
    // of the German body copy may reappear.
    expect(sw).not.toMatch(/Keine Internetverbindung/);
    expect(sw).not.toMatch(/Bitte versuche es später erneut/);
  });

  it("still renders the wordmark and the universal `Offline` token", () => {
    const sw = readSw();
    // The minimal language-neutral fallback still names the app and
    // surfaces the universally understood status token.
    expect(sw).toMatch(/HealthLog/);
    expect(sw).toMatch(/<p>Offline<\/p>/);
  });
});

describe("public/manifest.json PWA identity hygiene (F-7, 2026-05-16)", () => {
  it("declares an explicit scope, id, and display_override", () => {
    const raw = readFileSync(MANIFEST_PATH, "utf-8");
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    expect(manifest.scope).toBe("/");
    expect(manifest.id).toBe("/?source=pwa");
    expect(manifest.display_override).toEqual(["standalone"]);
  });

  it("keeps the existing display/start_url contract", () => {
    const raw = readFileSync(MANIFEST_PATH, "utf-8");
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
  });
});
