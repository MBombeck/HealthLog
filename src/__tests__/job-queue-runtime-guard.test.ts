/**
 * Structural guard: every pg-boss queue declares how long its job can run, and
 * a long one is safe against pg-boss's expiry.
 *
 * pg-boss gives a job fifteen minutes unless the send says otherwise, then
 * fails it, fires its abort signal and retries it while the handler keeps
 * going. The full-history imports ran beside themselves that way (#1066), and
 * so could every other job that legitimately needs longer: the nightly status
 * passes, the pre-generation, the record scan, the key rotation, the backups.
 *
 * `src/lib/jobs/queue-runtime.ts` declares every queue `short`, `budgeted` or
 * `long`. This guard holds the tree to it:
 *
 *   - every queue the worker registry declares (`jobs/registry/`) is in the
 *     table, and every table entry is declared;
 *   - every `boss.send` and every scheduled queue names a queue in the table;
 *   - a `long` queue has an expiry between the default and pg-boss's 24-hour
 *     ceiling, every send for it carries `expireInSeconds` (or an identifier
 *     the table names as its carrier) and its schedule's send options do, it
 *     stops on the job's budget where the table says (`jobBudget` /
 *     `jobDeadline`, or a declared one-shot), and it is exclusive per identity
 *     where the table says (the definition's `lock`, or the named marker);
 *   - a `budgeted` queue stops on the budget and relies on the default expiry;
 *   - a `short` queue's sends set no expiry of their own, which would mean the
 *     job is longer than the table claims.
 *
 * Floors fail the guard if a matcher stops matching, and the "plants" cases
 * run the checks over a planted long queue that lacks each protection in turn
 * (the mutation proof kept in the suite). Removing the `lock` from the
 * pr-detection definition, or the expiry from its schedule, fails the real
 * checks below.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { stripComments, walkSourceFiles } from "./helpers/source-files";
import {
  DEFAULT_JOB_EXPIRE_SECONDS,
  QUEUE_RUNTIME,
  type QueueRuntime,
} from "@/lib/jobs/queue-runtime";
import { SCHEDULED_AND_SENT_QUEUES } from "@/lib/jobs/reminder/registrar-shared";
import { HEAVY_QUEUES } from "@/lib/jobs/heavy-lane";
import type { JobDefinition } from "@/lib/jobs/registry/define-job";
import { allJobDefinitions } from "@/lib/jobs/registry/index";

const SRC = join(process.cwd(), "src");
const DEFINITIONS = allJobDefinitions();
/** pg-boss refuses an expiry of 24 hours or more. */
const MAX_EXPIRE_SECONDS = 24 * 60 * 60;

const files = walkSourceFiles(SRC, { floor: 3000 })
  .filter((p) => !p.startsWith("generated/"))
  .filter((p) => !p.includes("__tests__"))
  .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"));
const source = new Map(
  files.map((f) => [f, readFileSync(join(SRC, f), "utf8")]),
);

/** Strip comments so documentation that quotes code never matches. */
function code(text: string): string {
  return stripComments(text);
}

/** Index just past the bracket that closes the one at `open`. */
function closeOf(text: string, open: number): number {
  const pair: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const want = pair[text[open]];
  let depth = 1;
  let i = open + 1;
  while (depth > 0 && i < text.length) {
    if (text[i] === text[open]) depth += 1;
    else if (text[i] === want) depth -= 1;
    i += 1;
  }
  return i;
}

type Definitions = Map<string, Array<{ file: string; name: string }>>;

/** `const NAME = "queue-name"` definitions, per file. */
function definitionsOf(texts: ReadonlyMap<string, string>): Definitions {
  const definitions: Definitions = new Map();
  for (const [file, text] of texts) {
    for (const m of text.matchAll(
      /\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::\s*string\s*)?=\s*"([a-z0-9-]+)"/g,
    )) {
      const list = definitions.get(m[1]) ?? [];
      list.push({ file, name: m[2] });
      definitions.set(m[1], list);
    }
  }
  return definitions;
}

/** Resolve a queue identifier as seen from `file`, preferring its own. */
function resolve(
  definitions: Definitions,
  file: string,
  ident: string,
): string | null {
  const defs = definitions.get(ident) ?? [];
  const own = defs.find((d) => d.file === file);
  if (own) return own.name;
  const names = new Set(defs.map((d) => d.name));
  return names.size === 1 ? [...names][0] : null;
}

interface Site {
  file: string;
  queue: string;
  text: string;
}

/** Every `boss.send(QUEUE, …)` / `getGlobalBoss()?.send(QUEUE, …)`. */
function sends(
  texts: ReadonlyMap<string, string>,
  definitions: Definitions,
): Site[] {
  const out: Site[] = [];
  for (const [file, raw] of texts) {
    const text = code(raw);
    for (const m of text.matchAll(
      /\b(?:boss|getGlobalBoss\(\)\??)\s*\.\s*send\s*(?:<[^(]*?>)?\(\s*([A-Z][A-Z0-9_]*)/g,
    )) {
      const open = text.indexOf("(", text.indexOf("send", m.index));
      const queue = resolve(definitions, file, m[1]);
      if (queue) {
        out.push({ file, queue, text: text.slice(open, closeOf(text, open)) });
      }
    }
  }
  return out;
}

/** The text of `fn` (a function or a const) in `file`. */
function bodyOf(
  texts: ReadonlyMap<string, string>,
  site: { file: string; fn: string },
): string {
  const text = code(texts.get(site.file) ?? "");
  const m = new RegExp(
    `(?:function\\s+${site.fn}\\b|const\\s+${site.fn}\\b)`,
  ).exec(text);
  if (!m) return "";
  const end = text.indexOf("\n}", m.index);
  return text.slice(m.index, end < 0 ? undefined : end + 2);
}

const STOPS = /\bjob(?:Budget|Deadline)\s*\(/;

/** Every finding for one queue's declaration against the tree. */
function check(
  queue: string,
  entry: QueueRuntime,
  texts: ReadonlyMap<string, string>,
  all: { definitions: readonly JobDefinition[]; sends: Site[] },
): string[] {
  const problems: string[] = [];
  const definition = all.definitions.find((d) => d.queue === queue);
  const sends = all.sends.filter((s) => s.queue === queue);
  const scheduledExpiry = definition?.scheduleOptions?.expireInSeconds;
  if (entry.runtime === "long") {
    if (
      !(entry.expireInSeconds > DEFAULT_JOB_EXPIRE_SECONDS) ||
      !(entry.expireInSeconds < MAX_EXPIRE_SECONDS)
    ) {
      problems.push(`${queue}: expiry ${entry.expireInSeconds}s out of range`);
    }
    for (const site of sends) {
      const carried =
        /\bexpireInSeconds\b/.test(site.text) ||
        entry.expiryVia.some((v) => new RegExp(`\\b${v}\\b`).test(site.text));
      if (!carried) {
        problems.push(`${queue}: ${site.file} sends it without an expiry`);
      }
    }
    if (definition?.cron && typeof scheduledExpiry !== "number") {
      problems.push(`${queue}: its schedule carries no expiry`);
    }
    if (typeof entry.stop === "object" && "oneShot" in entry.stop) {
      if (entry.stop.oneShot.length < 20) {
        problems.push(`${queue}: a one-shot needs its reason`);
      }
    } else if (!STOPS.test(bodyOf(texts, entry.stop))) {
      problems.push(`${queue}: does not stop on the job's budget`);
    }
    if (entry.exclusive === "lockedPass") {
      if (!definition?.lock) {
        problems.push(`${queue}: definition holds no lock`);
      }
    } else if (
      !bodyOf(texts, entry.exclusive.at).includes(entry.exclusive.marker)
    ) {
      problems.push(`${queue}: no "${entry.exclusive.marker}" where declared`);
    }
  } else {
    if (entry.runtime === "budgeted") {
      if (!STOPS.test(bodyOf(texts, entry.budget))) {
        problems.push(`${queue}: does not stop on the job's budget`);
      }
    }
    for (const site of sends) {
      if (/\bexpireInSeconds\b/.test(site.text)) {
        problems.push(
          `${queue}: ${site.file} sets an expiry on a queue declared ${entry.runtime}`,
        );
      }
    }
    if (scheduledExpiry !== undefined) {
      problems.push(
        `${queue}: its schedule sets an expiry on a queue declared ${entry.runtime}`,
      );
    }
  }
  return problems;
}

function scan(texts: ReadonlyMap<string, string>) {
  return { sends: sends(texts, definitionsOf(texts)) };
}

describe("every queue declares its runtime", () => {
  const all = { definitions: DEFINITIONS, ...scan(source) };
  const declared = new Set(DEFINITIONS.map((d) => d.queue));

  it("finds the declarations, sends and schedules it is meant to police", () => {
    // Pinned below the counts on 2026-10-23 (122 / 64 / 78).
    expect(DEFINITIONS.length).toBeGreaterThanOrEqual(115);
    expect(all.sends.length).toBeGreaterThanOrEqual(50);
    expect(DEFINITIONS.filter((d) => d.cron).length).toBeGreaterThanOrEqual(70);
    expect(
      Object.values(QUEUE_RUNTIME).filter((e) => e.runtime === "long").length,
    ).toBeGreaterThanOrEqual(15);
  });

  it("every declared queue is in the table, and every entry is declared", () => {
    expect([...declared].filter((q) => !(q in QUEUE_RUNTIME)).sort()).toEqual(
      [],
    );
    expect(
      Object.keys(QUEUE_RUNTIME)
        .filter((q) => !declared.has(q))
        .sort(),
    ).toEqual([]);
  });

  it("every send names a queue in the table", () => {
    const unknown = all.sends
      .filter((s) => !(s.queue in QUEUE_RUNTIME))
      .map((s) => `${s.file} → ${s.queue}`);
    expect(unknown).toEqual([]);
  });

  it("every queue meets its declaration", () => {
    const problems = Object.entries(QUEUE_RUNTIME).flatMap(([queue, entry]) =>
      check(queue, entry, source, all),
    );
    expect(problems).toEqual([]);
  });

  it("plants: a long queue missing any protection is caught", () => {
    const file = "lib/jobs/planted.ts";
    const texts = (handler: string) =>
      new Map([
        ...source,
        [file, `export async function plant(jobs) {\n  ${handler}\n}\n`],
      ]);
    const entry: QueueRuntime = {
      runtime: "long",
      expireInSeconds: 3600,
      expiryVia: [],
      stop: { file, fn: "plant" },
      exclusive: "lockedPass",
      why: "planted",
    };
    const planted = (overrides: Partial<JobDefinition>): JobDefinition => ({
      queue: "planted-long",
      cron: "0 3 * * *",
      scheduleOptions: { expireInSeconds: 3600 },
      work: { localConcurrency: 1 },
      lock: () => "pass",
      load: async () => async () => ({ ok: true, did: {} }),
      ...overrides,
    });
    const findings = (
      handler: string,
      overrides: Partial<JobDefinition> = {},
    ) => {
      const t = texts(handler);
      return check("planted-long", entry, t, {
        definitions: [planted(overrides)],
        ...scan(t),
      });
    };
    const budgeted = "return run(jobBudget(jobs));";
    expect(findings(budgeted)).toEqual([]);
    expect(findings(budgeted, { scheduleOptions: { retryLimit: 0 } })).toEqual([
      "planted-long: its schedule carries no expiry",
    ]);
    expect(findings("return run(jobs);")).toEqual([
      "planted-long: does not stop on the job's budget",
    ]);
    expect(findings(budgeted, { lock: undefined })).toEqual([
      "planted-long: definition holds no lock",
    ]);
    expect(
      check(
        "planted-long",
        { ...entry, expireInSeconds: 900 },
        texts(budgeted),
        { definitions: [planted({})], ...scan(texts(budgeted)) },
      ),
    ).toEqual(["planted-long: expiry 900s out of range"]);
  });
});

/**
 * Queues a file sends to through a variable (`boss.send(queueName, …)`): every
 * known queue the file names, as a literal, a map value or an imported
 * `*_QUEUE` constant, counts as sent, because the matcher above cannot tell which one the variable holds.
 */
function dynamicallySent(texts: ReadonlyMap<string, string>): Set<string> {
  const definitions = definitionsOf(texts);
  const out = new Set<string>();
  for (const [file, raw] of texts) {
    const text = code(raw);
    if (
      !/\b(?:boss|getGlobalBoss\(\)\??)\s*\.\s*send\s*(?:<[^(]*?>)?\(\s*[a-z]/.test(
        text,
      )
    ) {
      continue;
    }
    for (const m of text.matchAll(/"([a-z0-9-]+)"/g)) {
      if (m[1] in QUEUE_RUNTIME) out.add(m[1]);
    }
    // A queue named through an imported constant counts the same.
    for (const m of text.matchAll(/\b([A-Z][A-Z0-9_]*_QUEUE)\b/g)) {
      const queue = resolve(definitions, file, m[1]);
      if (queue && queue in QUEUE_RUNTIME) out.add(queue);
    }
  }
  return out;
}

describe("a cron-fed queue polls slowly, a sent one does not", () => {
  const all = scan(source);
  const scheduled = new Set(
    DEFINITIONS.filter((d) => d.cron).map((d) => d.queue),
  );
  const sent = new Set([
    ...all.sends.map((s) => s.queue),
    ...dynamicallySent(source),
  ]);

  it("lists exactly the scheduled queues that also take sends", () => {
    const expected = [...scheduled].filter((q) => sent.has(q)).sort();
    expect([...SCHEDULED_AND_SENT_QUEUES].sort()).toEqual(expected);
    // Most scheduled queues are fed by their cron alone.
    expect(scheduled.size - expected.length).toBeGreaterThanOrEqual(40);
  });

  it("counts a send through a variable as a send to every queue the file names", () => {
    const dynamic = dynamicallySent(source);
    expect(dynamic.has("withings-activity-sync")).toBe(true);
    expect(dynamic.has("whoop-recovery-sync")).toBe(true);
  });
});

describe("heavy jobs share the lane", () => {
  const laned = DEFINITIONS.filter((d) => d.lane);

  it("puts every heavy queue in the lane, and nothing else", () => {
    expect(laned.map((d) => d.queue).sort()).toEqual(
      Object.keys(HEAVY_QUEUES).sort(),
    );
  });

  it("declares every heavy queue long, so its expiry, stop and exclusivity are proven", () => {
    // A heavy job is the one most likely to run past pg-boss's default
    // expiry, and the retry that follows an expiry runs it a second time.
    // `long` is the declaration the checks above hold to an explicit expiry,
    // a stop on the budget and a lock (or a named marker). A heavy queue
    // that is genuinely bounded far below the default may be named here
    // with its reason instead.
    const HEAVY_BUT_SHORT: Record<string, string> = {};
    const notLong = (table: Readonly<Record<string, QueueRuntime>>) =>
      Object.keys(HEAVY_QUEUES)
        .filter((q) => table[q]?.runtime !== "long" && !(q in HEAVY_BUT_SHORT))
        .sort();
    expect(notLong(QUEUE_RUNTIME)).toEqual([]);
    // The planted case: the fold as it was declared before, `short`.
    expect(
      notLong({
        ...QUEUE_RUNTIME,
        "rollup-full-backfill": { runtime: "short", why: "four statements" },
      }),
    ).toEqual(["rollup-full-backfill"]);
  });

  it("defers only on queues where a job can go back to created", () => {
    // A deferred job returns from active to created. Under `short` (one
    // queued job per key) and `stately` (one per state) a twin already
    // queued would refuse it, and the job would fail instead of waiting.
    const refusing = (definitions: readonly JobDefinition[]) =>
      definitions
        .filter(
          (d) => d.lane && /^(?:short|stately)$/.test(d.policy?.policy ?? ""),
        )
        .map((d) => d.queue)
        .sort();
    expect(DEFINITIONS.filter((d) => d.policy).length).toBeGreaterThanOrEqual(
      40,
    );
    expect(refusing(DEFINITIONS)).toEqual([]);
    // The planted case: the same check over a heavy queue declared `short`.
    expect(
      refusing([
        {
          queue: "data-backup",
          policy: { policy: "short", reason: "x" },
          work: { localConcurrency: 1 },
          lane: true,
          load: async () => async () => ({ ok: true, did: {} }),
        },
      ]),
    ).toEqual(["data-backup"]);
  });
});
