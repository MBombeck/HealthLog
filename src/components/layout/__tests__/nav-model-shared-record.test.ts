/**
 * What the navigation offers inside somebody else's record.
 *
 * Paint, not enforcement — every route behind a hidden entry refuses on its
 * own, from a frozen allowlist this model cannot reach. What these pin is that
 * the line is drawn in ONE place: the mobile bar's fixed slots, the sidebar,
 * the More hub and the shell's deep-link guard all ask the same list, so they
 * cannot end up disagreeing about what a delegate is offered.
 *
 * The default is the safe one. A destination that says nothing about sharing
 * drops out, so a surface added later is hidden until somebody has thought
 * about it rather than exposed until somebody notices.
 *
 * Mutation check, run: flip the default in `isNavDestinationVisible` so an
 * unflagged destination survives a switch → "hides everything that has not
 * been classified" goes red naming Insights and the Coach.
 */
import { describe, expect, it } from "vitest";

import {
  BOTTOM_NAV_PRIMARY_SLOT_HREFS,
  NAV_DESTINATIONS,
  isDestinationInSharedRecord,
  mobileMoreHubDestinations,
  visibleNavDestinations,
  visibleUtilityDestinations,
} from "../nav-model";

/** Everything enabled, so the module gate never masks the sharing gate. */
const ALL_MODULES = Object.fromEntries(
  NAV_DESTINATIONS.filter((d) => d.requiresModule).map((d) => [
    d.requiresModule as string,
    true,
  ]),
);

function hrefsInSharedRecord(): string[] {
  return visibleNavDestinations(ALL_MODULES, true, true).map((d) => d.href);
}

describe("the destination list under a switch", () => {
  it("still offers the health record itself", () => {
    const hrefs = hrefsInSharedRecord();
    // The non-zero proof for every negative assertion below: a gate that hid
    // everything would satisfy all of them and leave a delegate with a blank
    // app.
    expect(hrefs.length).toBeGreaterThan(5);
    expect(hrefs).toContain("/");
    expect(hrefs).toContain("/measurements");
    expect(hrefs).toContain("/medications");
    expect(hrefs).toContain("/labs");
  });

  it("hides everything that has not been classified", () => {
    const hrefs = hrefsInSharedRecord();
    const unflagged = NAV_DESTINATIONS.filter((d) => !d.sharedRecord).map(
      (d) => d.href,
    );
    // Non-zero: if every destination were flagged this loop would assert
    // nothing at all.
    expect(unflagged.length).toBeGreaterThan(0);
    for (const href of unflagged) {
      expect(
        hrefs,
        `${href} should not be offered inside a shared record`,
      ).not.toContain(href);
    }
  });

  it("hides the AI surfaces by name", () => {
    // Not incidental. Server-managed LLM egress of a person's health data
    // rides the consent THAT person gave for their own use, so a delegate
    // triggering it would create a consent-shaped act the owner never made.
    const hrefs = hrefsInSharedRecord();
    expect(hrefs).not.toContain("/insights");
    expect(hrefs).not.toContain("/coach");
  });

  it("changes nothing for a session in its own record", () => {
    const own = visibleNavDestinations(ALL_MODULES, true).map((d) => d.href);
    expect(own).toEqual(
      NAV_DESTINATIONS.filter((d) => !d.sharedRecordOnly).map((d) => d.href),
    );
    expect(own).not.toContain("/profile");
  });

  it("offers the read-only profile summary only inside a shared record", () => {
    expect(hrefsInSharedRecord()).toContain("/profile");
  });
});

describe("a module the RECORD does not track", () => {
  /**
   * #939 — the map `GET /api/auth/me` publishes is the RECORD's while a
   * session is switched into one, so this filter is what makes a guardian's
   * toggle visible. Before it, turning Cycle off for a profile left the Cycle
   * door standing in that profile's own navigation, and the toggle wrote a
   * column nothing on screen was reading.
   */
  it("drops its destination inside the record", () => {
    const withCycle = visibleNavDestinations(ALL_MODULES, true, true, null).map(
      (d) => d.href,
    );
    expect(withCycle).toContain("/cycle");

    const withoutCycle = visibleNavDestinations(
      { ...ALL_MODULES, cycle: false },
      true,
      true,
      null,
    ).map((d) => d.href);
    expect(withoutCycle).not.toContain("/cycle");
    // Only that one door: a module toggle is not a scope change.
    expect(withoutCycle).toContain("/measurements");
  });
});

describe("the utility tail under a switch", () => {
  it("disappears entirely", () => {
    // Settings holds credentials, integrations, notification channels and
    // grant management; Notifications is the delegate's own device business.
    expect(visibleUtilityDestinations({ sharedRecord: true })).toEqual([]);
    expect(visibleUtilityDestinations().length).toBeGreaterThan(0);
  });
});

describe("the mobile bar under a switch", () => {
  it("drops the same entries from the More hub", () => {
    const hub = mobileMoreHubDestinations({
      modules: ALL_MODULES,
      sharedRecord: true,
    }).map((d) => d.href);
    expect(hub.length).toBeGreaterThan(0);
    expect(hub).not.toContain("/coach");
    expect(hub).toContain("/measurements");
    for (const slot of BOTTOM_NAV_PRIMARY_SLOT_HREFS) {
      expect(hub).not.toContain(slot);
    }
  });

  it("answers for the fixed Insights slot from the same list", () => {
    // The bar carries its own literal for the fixed slots. Having it ASK the
    // model rather than carry a second answer is what stops the two surfaces
    // drifting — which is the whole reason this module exists.
    expect(isDestinationInSharedRecord("/insights")).toBe(false);
    expect(isDestinationInSharedRecord("/medications")).toBe(true);
  });
});

describe("the deep-link guard reads the same list", () => {
  it("covers a destination and everything beneath it", () => {
    expect(isDestinationInSharedRecord("/measurements")).toBe(true);
    expect(isDestinationInSharedRecord("/measurements/abc123")).toBe(true);
    expect(isDestinationInSharedRecord("/labs/panel/7")).toBe(true);
  });

  it("matches the dashboard exactly, so it does not swallow the app", () => {
    // `"/"` is a destination like any other, and a prefix match on it would
    // report every path in the product as covered — including /settings.
    expect(isDestinationInSharedRecord("/")).toBe(true);
    expect(isDestinationInSharedRecord("/settings/account")).toBe(false);
    expect(isDestinationInSharedRecord("/notifications")).toBe(false);
  });

  it("answers false for a path no destination claims", () => {
    // A surface nobody has classified is not one to open inside somebody
    // else's record.
    expect(isDestinationInSharedRecord("/some/new/surface")).toBe(false);
  });
});
