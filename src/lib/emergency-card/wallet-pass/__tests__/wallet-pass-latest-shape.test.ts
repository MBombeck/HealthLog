/**
 * `latestWalletPass` reads the pass and its link in one SQL statement instead
 * of through `WALLET_PASS_SELECT`, so a column added to the select would be
 * missing from the newest pass without a type error (the raw row is typed by
 * hand). This holds the statement's column aliases to the select's keys.
 */
import { describe, expect, it } from "vitest";

import { readSource } from "@/__tests__/helpers/source-files";

import { WALLET_PASS_SELECT } from "../service";

const SOURCE = readSource("src/lib/emergency-card/wallet-pass/service.ts", [
  "export async function latestWalletPass(",
  "JOIN emergency_card_links l ON l.id = wp.link_id",
]);

function statementAliases(): string[] {
  const start = SOURCE.indexOf("export async function latestWalletPass(");
  const body = SOURCE.slice(start, SOURCE.indexOf("LIMIT 1", start));
  const select = body.slice(body.indexOf("SELECT"), body.indexOf("FROM"));
  return select.split(",").map((column) => {
    const alias = /AS\s+"?(\w+)"?\s*$/.exec(column.trim());
    if (alias) return alias[1]!;
    return column.trim().split(".").pop()!;
  });
}

describe("latestWalletPass reads every column the pass select names", () => {
  it("covers the pass columns and the link's", () => {
    const aliases = statementAliases();
    expect(aliases.length).toBeGreaterThan(10);
    const { link, ...pass } = WALLET_PASS_SELECT;
    const linkKeys = Object.keys(link.select).map(
      (key) => `link${key[0]!.toUpperCase()}${key.slice(1)}`,
    );
    expect(new Set(aliases)).toEqual(
      new Set([...Object.keys(pass), ...linkKeys]),
    );
  });
});
