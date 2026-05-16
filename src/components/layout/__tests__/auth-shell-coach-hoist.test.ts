/**
 * v1.4.34 IW-B — auth-shell hoist contract.
 *
 * The Coach launch provider used to live on `app/insights/layout.tsx`,
 * which meant the drawer was only reachable from `/insights/**`. The
 * hoist moves the provider + the drawer mount to `<AuthShell>` so every
 * authenticated route (dashboard included) shares the same context and
 * can call `askCoach()` from any descendant.
 *
 * Project convention keeps this contract pinned at the source level
 * because `<AuthShell>` is hard to render under SSR (it reads
 * `useAuth()` + `usePathname()` + the router) and we don't want a fully
 * mocked `@testing-library/react` setup for a one-line invariant.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const AUTH_SHELL_PATH = resolve(
  __dirname,
  "..",
  "auth-shell.tsx",
);
const INSIGHTS_LAYOUT_PATH = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "app",
  "insights",
  "layout.tsx",
);

describe("v1.4.34 IW-B — CoachLaunchProvider hoist", () => {
  it("imports the CoachLaunchProvider in the auth-shell", () => {
    const source = readFileSync(AUTH_SHELL_PATH, "utf8");
    expect(source).toContain(
      'from "@/lib/insights/coach-launch-context"',
    );
    expect(source).toContain("CoachLaunchProvider");
  });

  it("mounts the LayoutCoachMount inside the auth-shell so the drawer is reachable globally", () => {
    const source = readFileSync(AUTH_SHELL_PATH, "utf8");
    expect(source).toContain("<LayoutCoachMount />");
  });

  it("no longer mounts the provider in the routed insights layout", () => {
    const source = readFileSync(INSIGHTS_LAYOUT_PATH, "utf8");
    // The provider import drops; the FAB import stays because the FAB
    // is still scoped to `/insights/**` only.
    expect(source).not.toContain(
      'from "@/lib/insights/coach-launch-context"',
    );
    // The drawer mount lives on the shell now — verify the routed
    // layout doesn't double-mount it.
    expect(source).not.toContain("import { LayoutCoachMount }");
    // FAB stays scoped to the routed insights surface.
    expect(source).toContain("LayoutCoachFab");
  });
});
