import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { globSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * Demo-mode mutation allowlist. On a `DEMO_MODE=true` deploy the proxy
 * 403s every non-GET `/api/*` request except a narrow allowlist. Login is
 * the historical baseline; the rest are the writes the demo has to make to
 * walk its own flows — the two dashboard display-pref blobs, the setup
 * flow's closed-enum answers and checkpoints, and the baseline profile
 * fields. None carries health data or free text.
 *
 * The demo is one published account every visitor signs into, so what a
 * visitor writes is what the next visitor finds. The refusals below are as
 * much of the contract as the admissions: free text that reaches the Coach
 * prompt, and anything that creates a second record, stay out.
 *
 * This guard locks the allowlist shape in place so a refactor can't
 * silently widen it (admitting a data-bearing mutation) or narrow it
 * (re-breaking the demo toggles). The whole block is gated on
 * `DEMO_MODE === "true"`, so production is unaffected by construction —
 * the final case proves the gate.
 */

vi.mock("@/lib/process-type", () => ({
  shouldRunWeb: () => true,
}));

import { proxy } from "../proxy";

function makeRequest(pathname: string, method: string): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, { method });
}

const ORIGINAL_DEMO_MODE = process.env.DEMO_MODE;

describe("proxy.ts DEMO_MODE mutation allowlist", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
  });

  afterEach(() => {
    if (ORIGINAL_DEMO_MODE === undefined) {
      delete process.env.DEMO_MODE;
    } else {
      process.env.DEMO_MODE = ORIGINAL_DEMO_MODE;
    }
  });

  it("permits the chart-overlay-prefs PUT (above-chart display toggles)", () => {
    const res = proxy(makeRequest("/api/dashboard/chart-overlay-prefs", "PUT"));
    expect(res.status).not.toBe(403);
  });

  it("permits the dashboard-widgets PUT (comparison-baseline selector)", () => {
    const res = proxy(makeRequest("/api/dashboard/widgets", "PUT"));
    expect(res.status).not.toBe(403);
  });

  it("permits the three setup-flow writes so the demo can finish onboarding", () => {
    // v1.39 (C1) — the design spec requires the demo to complete the same flow
    // with preset answers, and none of the three creates health data: closed
    // enum answers, the step ledger, and the module map derived from them.
    for (const [path, method] of [
      ["/api/onboarding/answers", "PATCH"],
      ["/api/onboarding/complete", "POST"],
      ["/api/onboarding/restart", "POST"],
    ] as const) {
      expect(
        proxy(makeRequest(path, method)).status,
        `${method} ${path} is blocked in the demo`,
      ).not.toBe(403);
    }
  });

  it("does not drag in a sibling verb on an allowlisted onboarding path", () => {
    // The allowlist pins method per path, so admitting the answers PATCH must
    // not open a DELETE somebody adds to that route later.
    expect(proxy(makeRequest("/api/onboarding/answers", "DELETE")).status).toBe(
      403,
    );
    expect(proxy(makeRequest("/api/onboarding/tour", "DELETE")).status).toBe(
      403,
    );
  });

  it("admits every mutating onboarding route, read off the route files", () => {
    // v1.39 (C2) — the demo has to be able to walk the whole flow, and the
    // flow's welcome and exit make writes the C1 allowlist did not carry: the
    // disclaimer acknowledgment (both welcome buttons await it) and the tour
    // checkpoint. A hand-kept list of three paths could not see the other
    // two, so this reads the route files instead: every exported mutating
    // handler under `src/app/api/onboarding` must pass the proxy.
    const onboardingApi = join(process.cwd(), "src/app/api/onboarding");
    const routes = globSync("**/route.ts", { cwd: onboardingApi })
      .map((p) => p.split(sep).join("/"))
      .sort();
    expect(routes.length, "the onboarding route files").toBeGreaterThan(3);
    const missing: string[] = [];
    for (const rel of routes) {
      const source = readFileSync(join(onboardingApi, rel), "utf8");
      const path = `/api/onboarding/${rel.replace(/\/route\.ts$/, "")}`;
      for (const method of ["POST", "PATCH", "PUT", "DELETE"] as const) {
        if (!new RegExp(`export const ${method}\\b`).test(source)) continue;
        if (proxy(makeRequest(path, method)).status === 403) {
          missing.push(`${method} ${path}`);
        }
      }
    }
    expect(missing, "onboarding writes the demo cannot make").toEqual([]);
  });

  it("permits the profile write the baseline step makes", () => {
    // v1.39 — a demo visitor who typed a height got a 403 and a generic
    // toast, because the confirm screen's own write was not on the list.
    // Date of birth, height and sex are closed, validated fields on the
    // account's own record and no health data, so the step can complete.
    expect(
      proxy(makeRequest("/api/auth/profile", "PUT")).status,
      "PUT /api/auth/profile is blocked in the demo",
    ).not.toBe(403);
  });

  it("refuses the free-text self-context write, which the demo shares", () => {
    // The demo is ONE published account every visitor signs into. Free text
    // that persists for the next visitor is not a demo affordance, and this
    // particular text is fed into the Coach prompt — an anonymous write into
    // an LLM prompt on a public instance, held until the next reseed. The
    // anamnesis card renders read-only in the demo instead, so nothing here
    // reaches a visitor as a failed save.
    expect(proxy(makeRequest("/api/coach/about-me", "PUT")).status).toBe(403);
  });

  it("refuses the managed-profile create, which needs a factor the demo has not got", () => {
    // `POST /api/managed-profiles` opens with `requireFreshMfa`. The demo
    // account has no second factor, so admitting it at the edge buys the
    // guardian arm nothing: the call is refused a layer later either way,
    // and the confirm screen already says the profile could not be created
    // without one.
    expect(proxy(makeRequest("/api/managed-profiles", "POST")).status).toBe(
      403,
    );
  });

  it("does not drag in a sibling verb on the baseline paths", () => {
    expect(proxy(makeRequest("/api/auth/profile", "DELETE")).status).toBe(403);
    expect(proxy(makeRequest("/api/managed-profiles", "DELETE")).status).toBe(
      403,
    );
    // The per-profile routes are a different path and stay closed.
    expect(
      proxy(makeRequest("/api/managed-profiles/abc", "DELETE")).status,
    ).toBe(403);
  });

  it("still blocks a health-data mutation (POST /api/measurements)", () => {
    const res = proxy(makeRequest("/api/measurements", "POST"));
    expect(res.status).toBe(403);
  });

  it("does not drag in the layout-reset DELETE on the allowlisted widgets path", () => {
    // The allowlist pins method per path; admitting the widgets PUT
    // must not open DELETE (which wipes the user's dashboard layout).
    const res = proxy(makeRequest("/api/dashboard/widgets", "DELETE"));
    expect(res.status).toBe(403);
  });

  it("is inert when DEMO_MODE is off — production is unaffected", () => {
    delete process.env.DEMO_MODE;
    // With the demo gate off, the proxy never short-circuits an API
    // mutation; the route's own auth/handler runs instead.
    const res = proxy(makeRequest("/api/measurements", "POST"));
    expect(res.status).not.toBe(403);
  });
});
