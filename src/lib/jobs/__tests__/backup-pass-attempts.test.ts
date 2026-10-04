import { describe, expect, it } from "vitest";

import {
  heldBackAccounts,
  orderInterruptedLast,
} from "../backup-pass-attempts";

type Row = { userId: string; startedAt: Date; finishedAt: Date | null };

/**
 * A weekly-style pass over `ids`: oldest copy first, held-back accounts last,
 * at most `budget` accounts per run, `kills` the accounts whose record kills
 * the process. Returns the accounts copied in each run.
 */
function simulate(opts: {
  ids: string[];
  budget: number;
  kills: Set<string>;
  runs: number;
  interruptedFirst?: string;
}): string[][] {
  let clock = 0;
  const attempts = new Map<string, Row>();
  const copiedAt = new Map<string, number>();
  if (opts.interruptedFirst) {
    attempts.set(opts.interruptedFirst, {
      userId: opts.interruptedFirst,
      startedAt: new Date(++clock),
      finishedAt: null,
    });
  }
  const copied: string[][] = [];
  for (let run = 0; run < opts.runs; run += 1) {
    const order = orderInterruptedLast(
      [...opts.ids]
        .map((id) => ({ id }))
        .sort(
          (a, b) => (copiedAt.get(a.id) ?? -1) - (copiedAt.get(b.id) ?? -1),
        ),
      heldBackAccounts([...attempts.values()]),
    );
    const thisRun: string[] = [];
    for (const { id } of order.slice(0, opts.budget)) {
      const row = attempts.get(id) ?? {
        userId: id,
        startedAt: new Date(0),
        finishedAt: null,
      };
      row.startedAt = new Date(++clock);
      attempts.set(id, row);
      if (opts.kills.has(id)) break; // the process dies; the run ends here
      row.finishedAt = new Date(++clock);
      copiedAt.set(id, clock);
      thisRun.push(id);
    }
    copied.push(thisRun);
  }
  return copied;
}

describe("heldBackAccounts", () => {
  const at = (ms: number) => new Date(ms);

  it("holds back an interrupted attempt that is the newest of the pass", () => {
    const held = heldBackAccounts([
      { userId: "x", startedAt: at(30), finishedAt: at(10) },
      { userId: "a", startedAt: at(20), finishedAt: at(21) },
    ]);
    expect([...held.keys()]).toEqual(["x"]);
  });

  it("releases it once a later run has started on another account", () => {
    const held = heldBackAccounts([
      { userId: "x", startedAt: at(30), finishedAt: null },
      { userId: "a", startedAt: at(40), finishedAt: at(41) },
    ]);
    expect(held.size).toBe(0);
  });

  it("ignores finished attempts", () => {
    const held = heldBackAccounts([
      { userId: "a", startedAt: at(40), finishedAt: at(41) },
    ]);
    expect(held.size).toBe(0);
  });
});

describe("the order across runs", () => {
  const ids = ["x", "a", "b", "c", "d"];

  it("keeps a record that kills the process from costing the others their copies", () => {
    // `x` has the oldest copy and kills every run that reaches it.
    const runs = simulate({ ids, budget: 99, kills: new Set(["x"]), runs: 6 });
    // The first run meets it unwarned; from then on it goes last every run,
    // because each crash makes its attempt the newest again.
    expect(runs[0]).toEqual([]);
    for (const run of runs.slice(1)) {
      expect([...run].sort()).toEqual(["a", "b", "c", "d"]);
    }
  });

  it("still copies an interrupted account when every run stops on its budget", () => {
    // `x` was interrupted once (a restart, not its record). Every run stops
    // after three accounts, so kept last for good it would never be reached.
    const runs = simulate({
      ids,
      budget: 3,
      kills: new Set(),
      runs: 4,
      interruptedFirst: "x",
    });
    const firstCopy = runs.findIndex((run) => run.includes("x"));
    expect(firstCopy).toBeGreaterThanOrEqual(0);
    expect(firstCopy).toBeLessThanOrEqual(1);
    // And every account gets a copy within the four runs.
    expect(new Set(runs.flat())).toEqual(new Set(ids));
  });
});
