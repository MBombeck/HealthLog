/**
 * v1.39 (C2) — every Q2 area and every connectable Q4 source has a target
 * on a surface that exists, so the first-result screen can never be handed
 * a task it cannot render.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ONBOARDING_AREA_KEYS } from "@/lib/modules/registry";
import { NAV_DESTINATIONS } from "@/components/layout/nav-model";

import {
  AREA_PAGE_HREF,
  AREA_READING_TARGETS,
  connectSourceView,
  deliveringSources,
  SOURCE_INTEGRATION,
} from "../first-result-config";
import { BROWSER_CONNECTABLE_SOURCES } from "../wizard-steps";

describe("first-result targets", () => {
  it("covers every area with exactly one of a form or a page", () => {
    for (const area of ONBOARDING_AREA_KEYS) {
      const hasForm = area in AREA_READING_TARGETS;
      const hasPage = area in AREA_PAGE_HREF;
      expect(hasForm !== hasPage, area).toBe(true);
    }
  });

  it("points every linked area at a destination the navigation knows", () => {
    const hrefs = new Set(NAV_DESTINATIONS.map((d) => d.href));
    for (const href of Object.values(AREA_PAGE_HREF)) {
      expect(hrefs.has(href), href).toBe(true);
    }
  });

  it("names an integration for every source the browser can connect", () => {
    for (const source of BROWSER_CONNECTABLE_SOURCES) {
      expect(SOURCE_INTEGRATION[source].anchor).toBeTruthy();
      expect(SOURCE_INTEGRATION[source].statusKey).toBeTruthy();
    }
  });
});

/**
 * v1.38.19 (wave B / C1, I2, I3) — what the connect step is allowed to say.
 *
 * The screen used to decide "connected" from the ledger's `state` field, whose
 * default meant the opposite of its name, and had one piece of copy for every
 * outcome. The decision is a pure function over the envelope entry now, so the
 * eight verdicts can be enumerated here rather than inferred from markup.
 */
describe("connectSourceView", () => {
  const cases = [
    ["disconnected", "connect", false],
    ["pending_first_sync", "result", true],
    ["fresh", "result", true],
    ["stale", "result", false],
    ["stalled", "attention", false],
    ["failing", "attention", false],
    ["reauth_required", "attention", false],
    ["parked", "attention", false],
  ] as const;

  it.each(cases)(
    "verdict %s renders the %s tile and settles=%s",
    (verdict, slot, settled) => {
      const view = connectSourceView("whoop", {
        connected: verdict !== "disconnected",
        configured: true,
        syncHealth: { verdict, since: "2026-09-01T00:00:00.000Z" },
        lastSuccessAt: "2026-09-01T00:00:00.000Z",
      });
      expect(view?.slot).toBe(slot);
      expect(view?.settled).toBe(settled);
      expect(view?.verdict).toBe(verdict);
    },
  );

  it("says nothing at all until the envelope has resolved", () => {
    expect(connectSourceView("whoop", undefined)).toBeNull();
  });

  it("does not read a fresh account's empty ledger as a connection", () => {
    // What a brand-new account publishes: no row anywhere, so `state` is the
    // synthetic `unknown` and the verdict is `disconnected`.
    const view = connectSourceView("whoop", {
      connected: false,
      configured: true,
      state: "unknown",
      syncHealth: { verdict: "disconnected", since: null },
      lastSuccessAt: null,
    });
    expect(view?.slot).toBe("connect");
    expect(view?.settled).toBe(false);
  });

  it("points a BYO provider with no credentials at the credentials", () => {
    const view = connectSourceView("whoop", {
      connected: false,
      configured: false,
      syncHealth: { verdict: "disconnected", since: null },
      lastSuccessAt: null,
    });
    expect(view?.slot).toBe("credentials");
  });

  it("points a shared-app provider with no usable app at the credentials", () => {
    const view = connectSourceView("oura", {
      connected: false,
      configured: false,
      available: false,
      syncHealth: { verdict: "disconnected", since: null },
      lastSuccessAt: null,
    });
    expect(view?.slot).toBe("credentials");
  });

  it("offers the connect card when the instance's shared app resolves", () => {
    const view = connectSourceView("oura", {
      connected: false,
      configured: false,
      available: true,
      syncHealth: { verdict: "disconnected", since: null },
      lastSuccessAt: null,
    });
    expect(view?.slot).toBe("connect");
  });

  it("never withholds the connect card from a self-hosted URL source", () => {
    const view = connectSourceView("nightscout", {
      connected: false,
      configured: false,
      syncHealth: { verdict: "disconnected", since: null },
      lastSuccessAt: null,
    });
    expect(view?.slot).toBe("connect");
  });

  it("dates a stale tile from the last value and a failing one from the streak", () => {
    expect(
      connectSourceView("whoop", {
        connected: true,
        configured: true,
        syncHealth: { verdict: "stale", since: "2026-08-01T00:00:00.000Z" },
        lastSuccessAt: "2026-08-20T00:00:00.000Z",
      })?.when,
    ).toBe("2026-08-20T00:00:00.000Z");
    expect(
      connectSourceView("whoop", {
        connected: true,
        configured: true,
        syncHealth: { verdict: "failing", since: "2026-08-01T00:00:00.000Z" },
        lastSuccessAt: null,
      })?.when,
    ).toBe("2026-08-01T00:00:00.000Z");
  });
});

/**
 * The connect step's copy is chosen by a key built at runtime from the
 * verdict, which the repo's three i18n guards cannot see into: a template
 * `ns.${x}` counts as covering its whole subtree, so a MEMBER missing from
 * every bundle is invisible to them. Enumerate the verdicts here instead —
 * the eight the server can resolve, in all seven locales.
 */
describe("connect-source state copy", () => {
  const VERDICTS = [
    "fresh",
    "stale",
    "stalled",
    "failing",
    "reauth_required",
    "parked",
    "pending_first_sync",
  ] as const;

  const LOCALES = readdirSync(join(__dirname, "../../../../messages"))
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({
      locale: file.replace(/\.json$/, ""),
      copy: JSON.parse(
        readFileSync(join(__dirname, "../../../../messages", file), "utf8"),
      ) as Record<string, never>,
    }));

  it("covers all seven locales", () => {
    expect(LOCALES.length).toBe(7);
  });

  it.each(LOCALES)(
    "names every verdict in $locale, with no English fallback",
    ({ locale, copy }) => {
      const block = (
        copy as unknown as {
          onboarding: {
            flow: {
              "first-result": {
                "connect-source": Record<string, Record<string, unknown>>;
              };
            };
          };
        }
      ).onboarding.flow["first-result"]["connect-source"];
      for (const verdict of VERDICTS) {
        const entry = block.state[verdict] as
          { title?: string; detail?: string } | undefined;
        expect(entry?.title, `${locale}/${verdict}.title`).toBeTruthy();
        expect(entry?.detail, `${locale}/${verdict}.detail`).toBeTruthy();
      }
      // `disconnected` is the one verdict with no state copy: it renders the
      // connect card or the credentials note, neither of which is a claim
      // about a connection that exists.
      expect(block.state.disconnected).toBeUndefined();
      expect(block.needsCredentials.title).toBeTruthy();
      expect(block.openSettings).toBeTruthy();
      expect(block.noDate).toBeTruthy();
    },
  );
});

/**
 * v1.38.19 (wave B / I1) — which sources the flow must stop offering.
 *
 * Only a connection that is actually delivering, or one whose data has merely
 * gone quiet: both are real connections the person made, and offering to make
 * them again is the wizard talking past the account it can see. Everything
 * else — never connected, first sync running, needs repairing — stays in the
 * priority, because there is still something to do or something to say.
 */
describe("deliveringSources", () => {
  function entry(integration: string, verdict: string) {
    return {
      integration,
      connected: verdict !== "disconnected",
      configured: true,
      syncHealth: { verdict, since: null },
      lastSuccessAt: null,
    };
  }

  it("names the sources that are delivering or merely quiet", () => {
    const set = deliveringSources([
      entry("whoop", "fresh"),
      entry("oura", "stale"),
      entry("polar", "pending_first_sync"),
      entry("fitbit", "reauth_required"),
      entry("withings", "disconnected"),
    ] as never);
    expect([...set].sort()).toEqual(["oura", "whoop"]);
  });

  it("names nothing while the envelope has not resolved", () => {
    expect(deliveringSources(undefined).size).toBe(0);
  });
});
