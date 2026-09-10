import { describe, expect, it } from "vitest";

import {
  SHARED_RECORD_DOMAIN_ROUTE_FAMILIES,
  resolveSharedRecordNavigation,
} from "@/lib/navigation/shared-record";
import { SHARE_DOMAINS } from "@/lib/sharing/scope";
import {
  isDestinationInSharedRecord,
  visibleNavDestinations,
} from "@/components/layout/nav-model";
import { resolveRecordPresentation } from "@/lib/navigation/record-presentation";

describe("shared-record navigation", () => {
  it("keeps every granted route family in one closed eight-domain inventory", () => {
    expect(Object.keys(SHARED_RECORD_DOMAIN_ROUTE_FAMILIES)).toEqual(
      SHARE_DOMAINS,
    );

    for (const domain of SHARE_DOMAINS) {
      expect(
        SHARED_RECORD_DOMAIN_ROUTE_FAMILIES[domain].length,
        `${domain} needs at least one route family`,
      ).toBeGreaterThan(0);
    }
  });

  it("offers a scoped grant only its matching doorway", () => {
    const navigation = resolveSharedRecordNavigation(["labs"]);

    expect(navigation.destinationHrefs).toEqual(["/labs"]);
    expect(navigation.allowsPath("/labs/panel/7")).toBe(true);
    expect(navigation.allowsPath("/medications")).toBe(false);

    expect(
      visibleNavDestinations(undefined, true, true, ["labs"]).map(
        (destination) => destination.href,
      ),
    ).toEqual(["/labs"]);
    expect(isDestinationInSharedRecord("/labs/panel/7", ["labs"])).toBe(true);
    expect(isDestinationInSharedRecord("/medications", ["labs"])).toBe(false);
  });

  it("keeps profile facts outside Settings and makes profile the scoped doorway", () => {
    const navigation = resolveSharedRecordNavigation(["profile"]);

    expect(SHARED_RECORD_DOMAIN_ROUTE_FAMILIES.profile).toEqual([
      "/profile",
      "/checkups",
      "/vaccinations",
    ]);
    expect(navigation.destinationHrefs).toEqual([
      "/profile",
      "/checkups",
      "/vaccinations",
    ]);
    expect(navigation.allowsPath("/profile")).toBe(true);
    expect(navigation.allowsPath("/vaccinations")).toBe(true);
    expect(navigation.allowsPath("/settings/anamnesis")).toBe(false);
  });

  it("presents the checkups page under both domains whose content it shows", () => {
    // The page holds two things: the preventive-care list, which is a
    // `measurements` read, and the visits section, which is `profile`. A grant
    // naming either one must be able to reach it; a grant naming neither must
    // not. Before the visits section the `measurements` omission was invisible,
    // because a whole-record grant admits every path regardless.
    expect(
      resolveSharedRecordNavigation(["measurements"]).allowsPath("/checkups"),
    ).toBe(true);
    expect(
      resolveSharedRecordNavigation(["profile"]).allowsPath("/checkups"),
    ).toBe(true);
    expect(resolveSharedRecordNavigation(null).allowsPath("/checkups")).toBe(
      true,
    );
    expect(
      resolveSharedRecordNavigation(["labs"]).allowsPath("/checkups"),
    ).toBe(false);

    // Listed twice, offered once: a grant holding both domains must not put
    // two identical entries in the navigation.
    expect(
      resolveSharedRecordNavigation([
        "measurements",
        "profile",
      ]).destinationHrefs.filter((href) => href === "/checkups"),
    ).toEqual(["/checkups"]);
  });

  /**
   * Scope and modules are two filters and they answer different questions.
   *
   * This case used to assert that the module map was IGNORED inside a shared
   * record, and the reason was sound at the time: the map `GET /api/auth/me`
   * published was the ACTOR's, which describes their own dashboard, so letting
   * it hide a domain the record had granted would have been the actor's
   * preference deciding somebody else's navigation.
   *
   * v1.38.14 (#939) removed the premise rather than the filter. The payload
   * now resolves the map for the RECORD the session is inside, so the map is
   * the record's own answer to "what does this record track" — and honouring
   * it is what makes a guardian's Modules toggle visible inside the profile it
   * was set for. The scope still decides which doors the grant opens; the map
   * decides which of them the record uses at all.
   */
  it("applies the record's own module map on top of its scope", () => {
    const scope = ["medications", "labs"] as const;

    expect(
      visibleNavDestinations({}, true, true, [...scope]).map(
        (destination) => destination.href,
      ),
    ).toEqual(["/medications", "/labs"]);

    // The record tracks medications and not labs. Both are in scope; one door
    // is offered.
    expect(
      visibleNavDestinations({ labs: false }, true, true, [...scope]).map(
        (destination) => destination.href,
      ),
    ).toEqual(["/medications"]);

    // And the scope still binds: a module the record tracks is not a door the
    // grant opens.
    expect(
      visibleNavDestinations({}, true, true, ["medications"]).map(
        (destination) => destination.href,
      ),
    ).toEqual(["/medications"]);
  });

  it("keeps whole-record navigation distinct from an all-sections scope", () => {
    const wholeRecord = resolveSharedRecordNavigation(null);
    const allSections = resolveSharedRecordNavigation([...SHARE_DOMAINS]);

    expect(wholeRecord.allowsPath("/")).toBe(true);
    expect(allSections.allowsPath("/")).toBe(false);
  });

  it("refuses unclassified direct URLs in presentation before pages start reads", () => {
    const navigation = resolveSharedRecordNavigation(["documents"]);

    expect(navigation.allowsPath("/documents/record-1")).toBe(true);
    expect(navigation.allowsPath("/settings/account")).toBe(false);
    expect(navigation.allowsPath("/new-unclassified-route")).toBe(false);
  });

  it("keeps server-resolved access and record kind distinct in chrome", () => {
    expect(
      resolveRecordPresentation({
        level: "read",
        canWrite: false,
        recordKind: "shared",
      }),
    ).toEqual({ access: "view", recordKind: "shared" });
    expect(
      resolveRecordPresentation({
        level: "write",
        canWrite: true,
        recordKind: "shared",
      }),
    ).toEqual({ access: "view-and-add", recordKind: "shared" });
    expect(
      resolveRecordPresentation({
        level: "manage",
        canWrite: true,
        recordKind: "shared",
      }),
    ).toEqual({ access: "manage", recordKind: "shared" });
    expect(
      resolveRecordPresentation({
        level: "manage",
        canWrite: true,
        recordKind: "managed",
      }),
    ).toEqual({ access: "manage", recordKind: "managed" });
  });

  it("fails closed when a malformed entry reaches presentation", () => {
    expect(
      resolveRecordPresentation({
        level: "manage",
        canWrite: false,
        recordKind: "managed",
      } as never),
    ).toEqual({ access: "view", recordKind: "self" });

    expect(
      resolveRecordPresentation({
        level: "unknown",
        canWrite: true,
        recordKind: "shared",
      } as never),
    ).toEqual({ access: "view", recordKind: "self" });
  });
});
