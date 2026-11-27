/**
 * The client tools' major caps the server major (#1431). `pg_dump` refuses a
 * server newer than its own major, and it says so in a line that, inside a
 * boot abort, did not point at the cause. These are the rules of the check
 * that runs before any client tool touches the server: how a `--version`
 * line and `server_version_num` are read, when the pair is refused, and the
 * one message an operator gets for it.
 */
import { describe, expect, it } from "vitest";

import {
  ClientTooOldError,
  assertClientServesServer,
  clientMajorFromVersionLine,
  clientServerMismatch,
  serverMajorFromVersionNum,
} from "../dump-core.mjs";
import { clientTooOldIn } from "../dump-problems";

describe("reading the client's major", () => {
  it.each([
    ["pg_dump (PostgreSQL) 16.4", 16],
    ["pg_dump (PostgreSQL) 18.6 (Debian 18.6-1.pgdg13+1)", 18],
    ["pg_restore (PostgreSQL) 19.0", 19],
    ["pg_dump (PostgreSQL) 20.1", 20],
    ["pg_dump (PostgreSQL) 19devel", 19],
    ["pg_dump (PostgreSQL) 19beta2", 19],
    ["pg_dump (PostgreSQL) 20rc1", 20],
    ["pg_dump (PostgreSQL) 9.6.24", 9],
    ["pg_dump (PostgreSQL) 18.6\n", 18],
  ])("%s is %i", (line, major) => {
    expect(clientMajorFromVersionLine(line)).toBe(major);
  });

  it.each([[null], [""], ["command not found"], ["pg_dump (PostgreSQL)"]])(
    "%j names no major",
    (line) => {
      expect(clientMajorFromVersionLine(line)).toBeNull();
    },
  );
});

describe("reading the server's major", () => {
  it.each([
    [160004, 16],
    [180006, 18],
    [190000, 19], // 19devel and 19beta report the .0
    [190001, 19],
    [200000, 20],
    [90624, 9],
  ])("%i is %i", (num, major) => {
    expect(serverMajorFromVersionNum(num)).toBe(major);
  });

  it.each([[null], [0], [-1], [Number.NaN], [1.5]])("%s is unknown", (num) => {
    expect(serverMajorFromVersionNum(num)).toBeNull();
  });
});

describe("which pairs are refused", () => {
  it.each([
    [19, 16],
    [19, 18],
    [19, 19],
    [20, 19],
  ])("client %i serves server %i", (client, server) => {
    expect(
      clientServerMismatch({
        tool: "pg_dump",
        clientMajor: client,
        serverMajor: server,
      }),
    ).toBeNull();
  });

  it.each([
    [18, 19],
    [19, 20],
    [16, 18],
  ])("client %i refuses server %i", (client, server) => {
    expect(
      clientServerMismatch({
        tool: "pg_dump",
        clientMajor: client,
        serverMajor: server,
      }),
    ).not.toBeNull();
  });

  // An unknown side is not a reason to refuse: the tool runs and says what
  // is wrong in its own words, as before the check existed.
  it.each([
    [null, 20],
    [19, null],
    [null, null],
  ])("client %s and server %s are not refused", (client, server) => {
    expect(
      clientServerMismatch({
        tool: "pg_dump",
        clientMajor: client,
        serverMajor: server,
      }),
    ).toBeNull();
  });

  it("names both majors and the way out, in one message that reads back", () => {
    const message = clientServerMismatch({
      tool: "pg_dump",
      clientMajor: 19,
      serverMajor: 20,
    });
    expect(message).toMatch(
      /^This image's PostgreSQL client \(pg_dump\) is 19; your server is 20\./,
    );
    expect(message).toContain("PostgreSQL 19 and older");
    expect(message).toContain("client is 20 or newer");
    expect(message).toContain("keep the server on 19 or older");
    expect(message).toContain("docs/ops/postgres-major-upgrade.md");
    // The ledger keeps 500 characters of a failure.
    expect(message!.length).toBeLessThanOrEqual(500);
    expect(clientTooOldIn(message)).toEqual({
      tool: "pg_dump",
      client: 19,
      server: 20,
    });
  });

  it("reads no mismatch out of any other failure", () => {
    expect(clientTooOldIn(null)).toBeNull();
    expect(
      clientTooOldIn(
        "pg_dump exited 1: pg_dump: error: aborting because of server version mismatch",
      ),
    ).toBeNull();
  });
});

describe("the check before a tool runs", () => {
  const server = (n: number | null) => ({
    query: async () =>
      n === null
        ? { rows: [] }
        : { rows: [{ v: `${Math.floor(n / 10000)}.0`, n }] },
  });

  it("refuses a server newer than the client, before the tool is run", async () => {
    const error = await assertClientServesServer(server(200000), "pg_dump", {
      versionLine: async () => "pg_dump (PostgreSQL) 19.1",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClientTooOldError);
    expect((error as ClientTooOldError).clientMajor).toBe(19);
    expect((error as ClientTooOldError).serverMajor).toBe(20);
    expect((error as Error).message).toMatch(
      /client \(pg_dump\) is 19; your server is 20/,
    );
  });

  it("lets an older or equal server through", async () => {
    for (const n of [160004, 180006, 190001]) {
      await expect(
        assertClientServesServer(server(n), "pg_restore", {
          versionLine: async () => "pg_restore (PostgreSQL) 19.1",
        }),
      ).resolves.toMatchObject({ clientMajor: 19 });
    }
  });

  it("lets the tool run when either major cannot be read", async () => {
    await expect(
      assertClientServesServer(server(null), "pg_dump", {
        versionLine: async () => "pg_dump (PostgreSQL) 19.1",
      }),
    ).resolves.toEqual({ clientMajor: 19, serverMajor: null });
    await expect(
      assertClientServesServer(server(200000), "pg_dump", {
        versionLine: async () => null,
      }),
    ).resolves.toEqual({ clientMajor: null, serverMajor: 20 });
  });
});
