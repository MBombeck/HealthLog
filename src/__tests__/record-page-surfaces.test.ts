/**
 * The page gate and the API gate answer the same question the same way.
 *
 * `RECORD_PAGE_SURFACES` (`src/lib/sharing/record-page-surfaces.ts`) states,
 * for each page that is not about one section of the record, the routes each
 * of its parts calls and the guard those routes resolve the caller with. The
 * browser paints the page from that rule: the shell's page gate
 * (`isSharedRecordPathOpen`), the Settings listing
 * (`isSettingsDestinationListedForRecord`) and every part on the page.
 *
 * Three things hold the two ends together:
 *
 *   1. Each part's routes resolve the caller with exactly the guard written
 *      next to them, read from the route file. Change a route's guard and the
 *      page's rule is wrong until somebody changes it too.
 *   2. Every route that admits a guardian (`requireGuardianAuth()`) is claimed
 *      by a page part, or names the page that calls it. The emergency card's
 *      routes admitted a guardian for a release while no page opened for one.
 *   3. For every record a browser can be inside, the page gate opens a listed
 *      page exactly when one of its parts admits that record, and the Settings
 *      listing agrees for the Settings page.
 */
import { describe, expect, it } from "vitest";

import {
  readSource,
  readSourceFolder,
  stripComments,
} from "@/__tests__/helpers/source-files";
import { holdsGuardianSurfaces } from "@/hooks/use-record-capabilities";
import { isSharedRecordPathOpen } from "@/lib/navigation/shared-record";
import { isSettingsDestinationListedForRecord } from "@/lib/record-settings/classification";
import {
  GUARDIAN_ROUTES_SERVED_ELSEWHERE,
  RECORD_PAGE_SURFACES,
  isRecordSurfacePagePresentable,
  isRecordSurfacePartPresentable,
  recordRuleAdmits,
  type RecordRouteRule,
  type RecordSurfacePart,
  type RecordViewer,
} from "@/lib/sharing/record-page-surfaces";

function routeSource(route: string): string {
  const rel = `src/app/api/${route}/route.ts`;
  return stripComments(readSource(rel, "apiHandler("), rel);
}

/** The guard calls a route file makes, by kind. */
function guardCalls(source: string) {
  return {
    owner: /\brequireAuth\(/.test(source),
    guardian: /\brequireGuardianAuth\(/.test(source),
    record: [
      ...source.matchAll(/\brequireRecordAuth\(\s*"([a-z]+)",\s*"([a-z]+)"/g),
    ].map((m) => `${m[1]}:${m[2]}`),
  };
}

const PARTS: Array<[string, string, RecordSurfacePart]> = Object.entries(
  RECORD_PAGE_SURFACES,
).flatMap(([page, parts]) =>
  Object.entries(parts as Record<string, RecordSurfacePart>).map(
    ([id, part]) => [page, id, part] as [string, string, RecordSurfacePart],
  ),
);

describe("each part's routes resolve the caller with the rule written beside them", () => {
  it.each(
    PARTS.flatMap(([page, id, part]) =>
      part.routes.map((route) => [`${page} ${id}`, route, part.rule] as const),
    ),
  )("%s: %s", (_label, route, rule: RecordRouteRule) => {
    const calls = guardCalls(routeSource(route));
    switch (rule.guard) {
      case "owner":
        expect(calls.owner).toBe(true);
        expect(calls.guardian).toBe(false);
        expect(calls.record).toEqual([]);
        break;
      case "guardian":
        expect(calls.guardian).toBe(true);
        expect(calls.owner).toBe(false);
        expect(calls.record).toEqual([]);
        break;
      case "record":
        expect(calls.owner).toBe(false);
        expect(calls.guardian).toBe(false);
        expect(calls.record.length).toBeGreaterThan(0);
        for (const call of calls.record) {
          expect(call).toBe(`${rule.level}:${rule.scope}`);
        }
        break;
    }
  });
});

describe("every route that admits a guardian has a page that opens for one", () => {
  const guardianRoutes = readSourceFolder("src/app/api", {
    floor: 300,
    include: (rel) => rel.endsWith("route.ts"),
  })
    .filter(([rel, text]) =>
      /\brequireGuardianAuth\(/.test(stripComments(text, rel)),
    )
    .map(([rel]) => rel.replace(/\/route\.ts$/, ""));

  it("finds the guardian routes at all", () => {
    expect(guardianRoutes.length).toBeGreaterThanOrEqual(10);
  });

  it.each(guardianRoutes)("%s is claimed", (route) => {
    const claimed = PARTS.some(
      ([, , part]) =>
        part.rule.guard === "guardian" && part.routes.includes(route),
    );
    expect(
      claimed || route in GUARDIAN_ROUTES_SERVED_ELSEWHERE,
      `${route} admits a guardian; name the page part that calls it in RECORD_PAGE_SURFACES, or the page in GUARDIAN_ROUTES_SERVED_ELSEWHERE`,
    ).toBe(true);
  });

  it("names no route there that does not admit a guardian", () => {
    for (const route of Object.keys(GUARDIAN_ROUTES_SERVED_ELSEWHERE)) {
      expect(guardianRoutes).toContain(route);
    }
  });
});

/** Every kind of record a browser can be inside. */
const VIEWERS: Array<[string, RecordViewer]> = [
  [
    "own record",
    { inSharedRecord: false, recordKind: "self", level: null, sections: null },
  ],
  ...(["read", "write", "manage"] as const).flatMap(
    (level): Array<[string, RecordViewer]> => [
      [
        `adult share, ${level}, whole record`,
        { inSharedRecord: true, recordKind: "shared", level, sections: null },
      ],
      [
        `adult share, ${level}, labs only`,
        {
          inSharedRecord: true,
          recordKind: "shared",
          level,
          sections: ["labs"],
        },
      ],
      [
        `managed profile, ${level}`,
        { inSharedRecord: true, recordKind: "managed", level, sections: null },
      ],
    ],
  ),
  [
    "a context the client could not prove",
    { inSharedRecord: true, recordKind: "shared", level: null, sections: [] },
  ],
];

describe("the page gate opens a page exactly when a part admits the record", () => {
  const pages = Object.keys(RECORD_PAGE_SURFACES);

  it.each(
    VIEWERS.flatMap(([label, viewer]) =>
      pages.map((page) => [label, page, viewer] as const),
    ),
  )("%s, %s", (_label, page, viewer) => {
    const parts = Object.values(
      RECORD_PAGE_SURFACES[page as keyof typeof RECORD_PAGE_SURFACES],
    ) as RecordSurfacePart[];
    const anyPart = parts.some((part) => recordRuleAdmits(part.rule, viewer));
    expect(isRecordSurfacePagePresentable(page, viewer)).toBe(anyPart);
    if (viewer.inSharedRecord) {
      // The shell's gate: a part that admits opens the page; with none, only
      // a section the grant covers can (the cycle page is both).
      if (anyPart) expect(isSharedRecordPathOpen(page, viewer)).toBe(true);
      if (!page.startsWith("/cycle") && !anyPart) {
        expect(isSharedRecordPathOpen(page, viewer)).toBe(false);
      }
    }
    if (page.startsWith("/settings/") && viewer.inSharedRecord) {
      expect(
        isSettingsDestinationListedForRecord(page.slice("/settings/".length), {
          recordKind: viewer.recordKind as "shared" | "managed",
          level: viewer.level,
          manageableDomains: [],
          sections: viewer.sections,
        }),
      ).toBe(anyPart);
    }
  });
});

describe("the rules read the record the way the server does", () => {
  it.each(VIEWERS)(
    "%s: the guardian rule is the guardian surfaces' rule",
    (_l, viewer) => {
      expect(recordRuleAdmits({ guard: "guardian" }, viewer)).toBe(
        holdsGuardianSurfaces(viewer),
      );
    },
  );

  it("the owner rule admits one's own record only", () => {
    for (const [, viewer] of VIEWERS) {
      expect(recordRuleAdmits({ guard: "owner" }, viewer)).toBe(
        !viewer.inSharedRecord,
      );
    }
  });

  it("a whole-record rule needs the level and a whole-record grant", () => {
    const rule = { guard: "record", level: "manage", scope: "record" } as const;
    const admitted = VIEWERS.filter(([, v]) => recordRuleAdmits(rule, v)).map(
      ([label]) => label,
    );
    expect(admitted).toEqual([
      "own record",
      "adult share, manage, whole record",
      "managed profile, manage",
    ]);
  });

  it("the emergency card is the guardian's and the owner's, never a delegate's", () => {
    const admitted = VIEWERS.filter(([, v]) =>
      isRecordSurfacePartPresentable("/emergency-card", "card", v),
    ).map(([label]) => label);
    expect(admitted).toEqual(["own record", "managed profile, manage"]);
  });
});
