/**
 * v1.32.36 — pair guard over the account payload (`GET /api/auth/me`), in both
 * directions.
 *
 * The recurring failure this exists to prevent: a two-ended feature whose ends
 * ship in different releases. The column lands with the schema change, the
 * payload field lands with the API change, and the client that was supposed to
 * read it is "the follow-up". Nothing in the gate notices, because every other
 * guard proves ONE end — typecheck proves the export exists, knip proves it is
 * imported, the OpenAPI check proves the schema matches. None of them prove the
 * pair.
 *
 * `/api/auth/me` is the preferences envelope: it rides every app boot and is
 * where user-facing preference fields surface. This test reads the field names
 * straight out of the route's response literal and asserts each one is read by
 * at least one client module. `lastReportPracticeName` shipped as column +
 * doc contract + payload field and sat NULL with no reader for several
 * releases; this guard would have failed on the commit that introduced it, and
 * the allowlist entry needed to silence it would have had no honest reason to
 * write.
 *
 * ## What it deliberately does not prove
 *
 * - It proves a field is READ somewhere, not that it is rendered correctly, nor
 *   that every surface that should read it does. That is what the
 *   unit-preference display guard does for its own narrower question.
 * - The matcher is textual (property access or destructuring position), so a
 *   field whose name collides with an unrelated local reads as consumed. Every
 *   such name in this payload (`id`, `email`, `role`, `gender`, `timezone`,
 *   `modules`) is consumed ubiquitously anyway, so the over-acceptance costs
 *   nothing here. It would cost something on a payload full of generic names,
 *   which is why this is a per-envelope guard and not a general sweep.
 * - It says nothing about iOS. A field consumed only by the native client must
 *   be allowlisted with that reason written down, and the reason is an
 *   assumption about another repository until an audit crosses over.
 *
 * ## The other direction: a reader with no field
 *
 * Everything above asks that a published field has a reader. It cannot see the
 * inverse — a client that reads a field the payload never published — and that
 * blind spot cost a shipped feature: the medication surface decided between
 * the server-side reminder switch and the client-managed chip on
 * `notificationPrefs.medication.clientManaged`, read off this payload, which
 * did not carry it. The flag was `undefined` for every account, so the chip
 * never rendered and a person whose phone owned the reminders was shown a
 * switch that decided nothing. Every guard was green.
 *
 * The last case closes it, and the shape it takes is deliberate. A typed guard
 * — one `AccountPayload` interface, `tsc` refusing an absent property — was the
 * first idea and does not work here: the consumers declare their own local
 * response interfaces (`interface UserPrefsResponse { … }`), so `tsc` checks
 * each file against its own private claim about the payload and agrees with
 * every one of them. So the check reads those local claims instead, out of the
 * file that makes them, and holds them against what the route publishes. It
 * asserts a non-zero match count, because a textual guard that silently
 * matches nothing is the failure mode this repository already has on record.
 *
 * Its limit, written down: it sees the response type a `/api/auth/me` read
 * names, so a consumer that types the read as `unknown` and indexes into it, or
 * imports its response type from another module, is invisible to it.
 *
 * Mutation check: append a field to the response literal in
 * `src/app/api/auth/me/route.ts` and this goes red; delete the practice-name
 * read in `health-record-export-panel.tsx` and it goes red too; delete
 * `notificationPrefs` from the response literal and the last case goes red
 * naming the medication notification section.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, it, expect } from "vitest";

const SRC = join(process.cwd(), "src");
const ME_ROUTE = join(SRC, "app", "api", "auth", "me", "route.ts");

/**
 * Where a client consumer may live. `src/app/api/**` is excluded — the server
 * writing the field is the other end of the pair, not a consumer of it.
 */
const CONSUMER_ROOTS = [
  join(SRC, "components"),
  join(SRC, "hooks"),
  join(SRC, "app"),
];

/**
 * Pruned on purpose: the generated Prisma client, build output, vendored
 * dependencies, and the suites themselves are not the tree under audit. Note
 * what is NOT pruned — this walk descends into dot-prefixed directories, so
 * `src/app/.well-known` is inside the sweep. `fs.globSync` would drop it.
 */
const SKIP_DIRS = new Set([
  "__tests__",
  "__mocks__",
  "node_modules",
  ".next",
  "generated",
]);

/**
 * `src/hooks/use-auth.ts` declares the `AuthUser` transport type. Naming a
 * field in a type declaration is not consuming it — that is precisely the
 * shape `lastReportPracticeName` had while it was dead — so the declaration
 * file is not a consumer.
 */
const NOT_A_CONSUMER = new Set([
  join(SRC, "hooks", "use-auth.ts"),
  join(SRC, "app", "api", "auth", "me", "route.ts"),
]);

/**
 * The surfaces that read a per-account access ENTRY. This was one file (the
 * dashboard's caring-for card) until that card came off the dashboard —
 * records other people share are reached from the account switcher instead.
 * A single named file was the fragile part: the guarantee is "every additive
 * field has a reader", not "this one component still exists".
 */
const ACCOUNT_ENTRY_CONSUMERS = [
  join(SRC, "lib", "navigation", "record-presentation.ts"),
  join(SRC, "components", "layout", "account-switcher-menu.tsx"),
];
const ACTIVE_RECORD_CONSUMER = join(SRC, "hooks", "use-record-capabilities.ts");

/**
 * The names an access ENTRY is bound to at the two consumer sites. Pinning
 * these is what stops the matcher from accepting `.level` on an unrelated
 * object; a new consumer that binds it under a third name adds that name here,
 * which is a deliberate edit rather than a silent widening.
 */
const ENTRY_BINDINGS = ["entry", "account"];
const ACCOUNT_ACCESS_ADDITIVE_FIELDS = [
  "level",
  "sections",
  "recordKind",
] as const;

/**
 * v1.38.12 — fields that answer "what may I do in the record I am inside",
 * which only the active-record consumer has a use for. The switcher and the
 * navigation presentation say what was granted (`level`, `sections`); the
 * controls read these two lists. Requiring an entry-site reader for them
 * would be an artificial read written to satisfy this guard, so they are
 * checked against the active-record consumer only.
 */
const ACTIVE_RECORD_ONLY_FIELDS = [
  "writableDomains",
  "manageableDomains",
] as const;

/**
 * Fields with no client reader, each with the reason it is nonetheless
 * correct for the payload to carry it. An entry here is a claim; write one
 * only when the claim is true and checkable.
 */
const NO_CLIENT_CONSUMER: Record<string, string> = {
  insurerIkNumber:
    "No web surface reads or writes it — the account form offers the insurer name and the " +
    "insurance number, not the institution number. The native client does consume it: it " +
    "builds the FHIR Coverage payor from insurerName-or-IK, per " +
    ".planning/ios-coord/v0.11-ios-to-server-kvnr-only-coverage.md. Server-side the stored " +
    "value feeds the doctor-report cover and the Coverage resource in the health-record " +
    "export. The missing web field is a real gap, deliberately not closed in a guard-only " +
    "release; this entry is what keeps it visible.",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      // The API tree is the producing end, never the consuming one.
      if (p === join(SRC, "app", "api")) continue;
      walk(p, out);
    } else if (
      (name.endsWith(".ts") || name.endsWith(".tsx")) &&
      !NOT_A_CONSUMER.has(p) &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".test.tsx")
    ) {
      out.push(p);
    }
  }
  return out;
}

/** Top-level keys of the `apiSuccess({ … })` literal the route returns. */
function payloadFields(source: string): string[] {
  const start = source.indexOf("return apiSuccess({");
  expect(start).toBeGreaterThan(-1);
  const body = source.slice(start);
  const fields: string[] = [];
  for (const m of body.matchAll(/^ {4}([a-zA-Z_$][\w$]*)\s*[:,]/gm)) {
    fields.push(m[1]);
  }
  return [...new Set(fields)];
}

/**
 * Comments are stripped before matching. A doc comment naming a field is a
 * claim about a consumer, not a consumer — `lastReportPracticeName` had one of
 * those for its whole dead life, and counting it would make this guard agree
 * with the very prose that was wrong.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

/**
 * A property access (`user.glucoseUnit`) or a destructuring / object position
 * (`{ glucoseUnit }`, `{ glucoseUnit: unit }`).
 */
function readsField(text: string, field: string): boolean {
  const re = new RegExp(
    `\\.\\s*${field}(?![\\w$])|[{,]\\s*${field}\\s*[,}:=]`,
    "m",
  );
  return re.test(text);
}

/**
 * Top-level member names of a locally declared `interface Name { … }`, or null
 * when the file does not declare one under that name (the type is imported, or
 * is a shared transport type this file only references).
 *
 * Members are read at one indent level, the same way the route's response
 * literal is read above — the tree is prettier-formatted, so a nested object's
 * keys sit deeper and are not mistaken for top-level fields.
 */
function declaredMembers(text: string, name: string): string[] | null {
  const open = new RegExp(`\\binterface\\s+${name}\\s*\\{`).exec(text);
  if (!open) return null;
  const start = open.index + open[0].length;
  const end = text.indexOf("\n}", start);
  if (end === -1) return null;
  const body = text.slice(start, end);
  return [
    ...new Set(
      [...body.matchAll(/^ {2}([a-zA-Z_$][\w$]*)\??\s*[?:]/gm)].map(
        (m) => m[1],
      ),
    ),
  ];
}

describe("account payload consumer guard", () => {
  const source = readFileSync(ME_ROUTE, "utf8");
  const fields = payloadFields(source);
  const consumerFiles = CONSUMER_ROOTS.flatMap((root) => walk(root));
  const consumerText = consumerFiles.map((f) =>
    stripComments(readFileSync(f, "utf8")),
  );

  it("reads a plausible field set out of the route", () => {
    expect(fields.length).toBeGreaterThan(20);
    expect(fields).toContain("lastReportPracticeName");
    expect(fields).toContain("moduleAvailability");
    expect(consumerFiles.length).toBeGreaterThan(200);
  });

  it("every field the account endpoint returns has a client consumer", () => {
    const unconsumed = fields.filter(
      (field) =>
        !(field in NO_CLIENT_CONSUMER) &&
        !consumerText.some((text) => readsField(text, field)),
    );

    if (unconsumed.length > 0) {
      const report = unconsumed.map((f) => `  ❌ ${f}`).join("\n");
      throw new Error(
        `GET /api/auth/me returns ${unconsumed.length} field(s) no client module reads:\n${report}\n\n` +
          "Wire the consumer in the same release, or add the field to " +
          "NO_CLIENT_CONSUMER with the reason it is correct to ship unread. " +
          "A field with no honest reason belongs in neither the payload nor the schema.",
      );
    }
  });

  it("the allowlist carries no stale entry", () => {
    for (const [field, reason] of Object.entries(NO_CLIENT_CONSUMER)) {
      expect(
        fields,
        `${field} is allowlisted but no longer returned`,
      ).toContain(field);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it("has a consumer that ADOPTS the record-session context, not only a type for it", () => {
    // `recordSession` is the field the fence hands the browser, and the whole
    // point of it is that a client adopts the server's value rather than
    // deriving one. The generic sweep above is satisfied by any read anywhere;
    // this leg names the two places that have to do the adopting, because a
    // payload field read only by the transport type is the shape the file's
    // opening paragraph is about.
    expect(fields).toContain("recordSession");

    const adopters = [
      join(SRC, "hooks", "use-account-switch.ts"),
      join(SRC, "hooks", "use-record-capabilities.ts"),
    ];
    let reads = 0;
    for (const file of adopters) {
      expect(stripComments(readFileSync(file, "utf8"))).toMatch(
        /recordSession/,
      );
      reads += 1;
    }
    expect(reads).toBe(adopters.length);
    expect(reads).toBeGreaterThan(0);
  });

  it("has non-zero entry and active-record readers for additive access fields", () => {
    const entrySources = ACCOUNT_ENTRY_CONSUMERS.map((file) =>
      stripComments(readFileSync(file, "utf8")),
    );
    const activeSource = stripComments(
      readFileSync(ACTIVE_RECORD_CONSUMER, "utf8"),
    );

    const readerCount = ACCOUNT_ACCESS_ADDITIVE_FIELDS.reduce(
      (count, field) => {
        // The read has to be a read OF THE PAYLOAD ENTRY, so the matcher names
        // the bindings the entry actually arrives under. `\w\.<field>` would
        // have accepted `.level` on any object in the file — a chart's zoom
        // level, a log record's level — and reported a consumer that does not
        // exist. An empty match set fails rather than passing quietly.
        const read = new RegExp(
          `\\b(?:${ENTRY_BINDINGS.join("|")})\\.${field}(?![\\w$])`,
        );
        const readers = entrySources.filter((source) => read.test(source));
        expect(
          readers.length,
          `no client reader for account access field \`${field}\` bound as ${ENTRY_BINDINGS.join(" / ")}`,
        ).toBeGreaterThan(0);
        expect(activeSource).toMatch(new RegExp(`active\\.${field}(?![\\w$])`));
        return count + readers.length + 1;
      },
      0,
    );

    expect(readerCount).toBeGreaterThan(0);

    for (const field of ACTIVE_RECORD_ONLY_FIELDS) {
      expect(
        activeSource,
        `no active-record reader for account access field \`${field}\``,
      ).toMatch(new RegExp(`active\\.${field}(?![\\w$])`));
    }
  });

  it("every field a client types onto the account payload is published", () => {
    const published = new Set(fields);
    const offenders: string[] = [];
    let claimsChecked = 0;

    for (const file of consumerFiles) {
      const text = stripComments(readFileSync(file, "utf8"));
      // The type argument of a read of THIS endpoint. `/api/auth/me/...`
      // siblings are different payloads, so the literal is anchored closed.
      for (const call of text.matchAll(
        /<\s*([A-Za-z_$][\w$]*)\s*>\s*\(\s*"\/api\/auth\/me"\s*\)/g,
      )) {
        const declared = declaredMembers(text, call[1]);
        if (declared === null) continue; // an imported / shared type
        claimsChecked += 1;
        for (const member of declared) {
          if (!published.has(member)) {
            offenders.push(
              `${relative(process.cwd(), file)} reads \`${member}\``,
            );
          }
        }
      }
    }

    expect(
      claimsChecked,
      "no client names a response type for GET /api/auth/me, so this case matched nothing rather than proving anything",
    ).toBeGreaterThan(0);

    expect(
      offenders,
      "these clients type a field onto the account payload that the route does not publish, so it is `undefined` for every account and whatever it decides never happens",
    ).toEqual([]);
  });
});
