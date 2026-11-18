/**
 * A module page's title is a `PageHeader` (UI standards §1, §5): the H1 on
 * one tier (`text-2xl font-bold tracking-tight`), its explainer muted under
 * it, its actions beside it.
 *
 * Four in-app headings were hand-rolled beside it — the insights sub-page
 * shell (`text-xl sm:text-2xl font-semibold`), the medication detail, the
 * check-in and its result (`font-semibold`) — and each read a step lighter
 * than every other page title. They go through `PageHeader` now; this guard
 * keeps a new `<h1>` literal from appearing outside the places where a
 * different heading is the point.
 *
 * Matched: an `<h1` tag in JSX under `src/components` and `src/app`, with
 * comments stripped first, so a file that only talks about an H1 needs no
 * entry and every entry below is a heading that is actually rendered.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { stripComments, walkSourceFiles } from "./helpers/source-files";

const SRC = join(__dirname, "..");

const ALLOWED: Record<string, string> = {
  "components/ui/page-header.tsx": "the primitive",
  // Hero identity surfaces, not page titles.
  "components/insights/hero-strip.tsx": "insights hero greeting",
  "components/insights/coach-panel/coach-hero.tsx": "Coach hero",
  "components/insights/coach-panel/coach-conversation.tsx":
    "screen-reader title while the hero is folded away",
  // The first-run flow: full-screen steps with their own focus management.
  "components/onboarding/step-heading.tsx": "first-run step heading",
  // Outside the app shell: sign-in, register, claim, invite, the share-link
  // gate, the key-mismatch gate.
  "app/auth/login/page.tsx": "sign-in card",
  "app/auth/register/page.tsx": "register card",
  "components/auth/claim-profile.tsx": "claim card",
  "components/auth/native-return-notice.tsx": "native sign-in return card",
  "app/invite/[token]/page.tsx": "invalid invite screen",
  "components/clinician/share-unlock-gate.tsx": "share-link unlock gate",
  "app/key-mismatch-page.tsx": "key-mismatch gate",
  // Error and not-found screens.
  "app/not-found.tsx": "not-found screen",
  "app/c/[token]/not-found.tsx": "share-link not-found screen",
  "app/c/error.tsx": "share-link error screen",
  "app/global-error.tsx": "renders without the stylesheet",
  "components/error-details.tsx": "error boundary",
  // Prose pages (the prose H1 tier, §5).
  "app/about/page.tsx": "prose page",
  "app/privacy/page.tsx": "prose page",
};

describe("page titles go through PageHeader", () => {
  const files = walkSourceFiles(SRC, { floor: 2500 }).filter(
    (p) =>
      p.endsWith(".tsx") &&
      (p.startsWith("components/") || p.startsWith("app/")) &&
      !p.includes("__tests__/"),
  );
  const hasH1 = (source: string) => /<h1[\s>]/.test(stripComments(source));
  const withH1 = files.filter((p) => hasH1(readFileSync(join(SRC, p), "utf8")));

  it("finds the H1 sites at all", () => {
    expect(withH1.length).toBeGreaterThan(10);
  });

  it("has no hand-rolled H1 outside the allowlist", () => {
    expect(withH1.filter((p) => !(p in ALLOWED))).toEqual([]);
  });

  it("counter-check: an H1 in code counts, one in a comment does not", () => {
    expect(hasH1(`return <h1 className="text-2xl">Title</h1>;`)).toBe(true);
    expect(hasH1(`// the page's <h1> lives in PageHeader\nreturn null;`)).toBe(
      false,
    );
    expect(hasH1(`/* an <h1> above */ return <h2>x</h2>;`)).toBe(false);
  });

  it("keeps every allowlist entry live", () => {
    const set = new Set(withH1);
    for (const key of Object.keys(ALLOWED))
      expect(set.has(key), key).toBe(true);
  });
});
