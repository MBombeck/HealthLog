/**
 * The integration cards render the server's `health` and nothing else.
 *
 * Before v1.42.4 each card combined the ledger state, the liveness verdict,
 * token expiry, plan and scope lists and a reauth flag in its own way, so one
 * fact could read as a red error on one card and a footnote on the next. The
 * server now folds all of it into `health`, and this pins that no card under
 * this folder starts reading the old fields again, which is the one way a
 * second status dialect could come back. The managed-profile status view is
 * held to the same rule.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

import { walkSourceFiles } from "@/__tests__/helpers/source-files";

import { failureStreakFor, pickStatus } from "../shared";

describe("failureStreakFor", () => {
  it("pairs the largest per-kind streak with the envelope threshold", () => {
    const status = pickStatus(
      {
        threshold: 3,
        integrations: [
          {
            integration: "withings",
            consecutiveFailuresByKind: {
              transient: 1,
              reauth_required: 2,
              persistent: 0,
            },
          },
        ],
      },
      "withings",
    );
    expect(failureStreakFor(status)).toEqual({ count: 2, threshold: 3 });
  });

  it("reports nothing for a healthy zero-count status", () => {
    const status = pickStatus(
      {
        threshold: 3,
        integrations: [
          {
            integration: "withings",
            consecutiveFailuresByKind: {
              transient: 0,
              reauth_required: 0,
              persistent: 0,
            },
          },
        ],
      },
      "withings",
    );
    expect(failureStreakFor(status)).toBeNull();
  });
});

describe("structural guard: cards read health, not the retired fields", () => {
  const SRC = join(process.cwd(), "src");
  const CARDS = "components/settings/integrations";
  const MANAGED = "components/settings/managed-integration-status.tsx";

  /**
   * Fields the server keeps on the wire for one transition release and that
   * `health` replaces. Matched as property reads in the parsed source, so a
   * comment or an i18n key that happens to contain the word is not a read.
   */
  const RETIRED = new Set([
    "lastError",
    "state",
    "needsReauth",
    "planUnavailable",
    "scopeReconnect",
    "syncHealth",
    "tokenExpired",
    "tokenExpiresAt",
    "hasActivityScope",
    "legacyLastSyncedAt",
    "consecutiveFailures",
  ]);

  /**
   * `.state` is also the name of `health.state` and of a Google Health sync
   * run's progress state, and of the Garmin key's expiry state (a server-
   * resolved fact of its own, not a ledger state). Those bases are the
   * allowed readers; any other base reading `.state` is a ledger state
   * finding its way back onto a card.
   */
  const STATE_READERS =
    /(^|\.)(health|progress|syncProgress|record|keyExpiry)$/;

  const files = [
    ...walkSourceFiles(join(SRC, CARDS), { floor: 15 })
      .filter((p) => !p.includes("__tests__") && !p.endsWith(".test.ts"))
      .map((p) => `${CARDS}/${p}`),
    MANAGED,
  ];

  function retiredReads(rel: string): string[] {
    const path = join(SRC, rel);
    const file = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const found: string[] = [];
    function visit(node: ts.Node): void {
      if (ts.isPropertyAccessExpression(node)) {
        const name = node.name.text;
        const base = node.expression.getText(file).replace(/\?$/, "");
        if (
          RETIRED.has(name) &&
          !(name === "state" && STATE_READERS.test(base))
        ) {
          found.push(`${rel}: ${base}.${name}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    return found;
  }

  it("walks the cards and the managed view", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain(`${CARDS}/integration-card.tsx`);
    expect(files).toContain(`${CARDS}/oauth-integration-card.tsx`);
    expect(files).toContain(MANAGED);
  });

  it("no card reads a retired health-shaped field", () => {
    expect(files.flatMap(retiredReads)).toEqual([]);
  });

  it("the card data types do not declare them either", () => {
    // The compiler is the stronger half of this guard: a field the view model
    // does not declare cannot be read without a cast.
    const shared = readFileSync(join(SRC, CARDS, "shared.tsx"), "utf8");
    const viewModel = shared.slice(
      shared.indexOf("export interface IntegrationStatusViewModel"),
      shared.indexOf("export interface IntegrationStatusEnvelope"),
    );
    expect(viewModel.length).toBeGreaterThan(100);
    for (const field of RETIRED) {
      expect(viewModel, field).not.toMatch(new RegExp(`\\b${field}\\??:`));
    }
  });

  it("no card paints the old status pill", () => {
    const offenders = files.filter((rel) =>
      /<IntegrationStatusPill\b/.test(readFileSync(join(SRC, rel), "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
