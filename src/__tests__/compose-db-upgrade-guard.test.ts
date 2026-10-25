import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The wiring around `db-upgrade` in docker-compose.yml, the one-time move of a
 * Postgres 16 database from v1.45 or earlier into Postgres 18.
 *
 * What the move does is proven against real containers by
 * `scripts/compose-db-upgrade-check.sh` (the "Compose database move"
 * workflow). That check starts `db-upgrade` by name, so it cannot see the
 * part that protects an operator's data on a normal `docker compose up`: the
 * app must wait for the move to succeed, or it starts on an empty Postgres 18
 * database and the instance looks wiped. This file freezes that and the
 * volume layout the move depends on.
 */

type Service = {
  image?: string;
  restart?: string;
  volumes?: string[];
  depends_on?: Record<string, { condition?: string }>;
  command?: string[];
};

const compose = parse(
  readFileSync(resolve(__dirname, "../../docker-compose.yml"), "utf8"),
) as { services: Record<string, Service>; volumes: Record<string, unknown> };
const { app, db } = compose.services;
const upgrade = compose.services["db-upgrade"];

function major(image: string | undefined): number {
  const match = image?.match(/^postgres:(\d+)\./);
  if (!match) throw new Error(`not a pinned postgres image: ${image}`);
  return Number(match[1]);
}

describe("the Postgres 16 -> 18 move in docker-compose.yml", () => {
  it("starts the app only after the move succeeded", () => {
    expect(app.depends_on?.["db-upgrade"]?.condition).toBe(
      "service_completed_successfully",
    );
    expect(app.depends_on?.db?.condition).toBe("service_healthy");
  });

  it("moves into a running database", () => {
    expect(upgrade.depends_on?.db?.condition).toBe("service_healthy");
  });

  it("reads the old data with the major that wrote it", () => {
    expect(major(upgrade.image)).toBe(16);
    expect(major(db.image)).toBe(18);
    expect(upgrade.volumes).toContain("pgdata:/var/lib/postgresql/data");
  });

  it("keeps the new data where the Postgres 18 image expects it", () => {
    // Mounted at .../data, as 16 had it, the 18 image refuses to start.
    expect(db.volumes).toEqual(["postgres-data:/var/lib/postgresql"]);
    // `backups` holds the app's database dumps, not database files.
    expect(Object.keys(compose.volumes).sort()).toEqual([
      "backups",
      "pgdata",
      "postgres-data",
    ]);
  });

  it("runs once per start instead of restarting", () => {
    // A restart policy would rerun a failed move in a loop; "no" also keeps
    // Coolify from counting the exited container as a failed service.
    expect(upgrade.restart).toBe("no");
  });

  it("never fills a database that already holds data", () => {
    const script = upgrade.command?.join("\n") ?? "";
    // The checks run before the restore, in this order.
    const order = [
      "PG_VERSION",
      "$$MARK",
      "$$MOVING",
      'elif [ "$$TABLES" != 0 ]',
      "pg_restore",
    ].map((needle) => script.indexOf(needle));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(script).toContain("--single-transaction");
  });
});
