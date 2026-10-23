/**
 * A fenced route may not be reached by a transport that cannot carry a header.
 *
 * The record-session fence is asserted on request HEADERS, attached inside
 * `src/lib/api/api-fetch.ts`. Three browser transports never go through that
 * wrapper and cannot be made to:
 *
 *   * `<img src="/api/…">` — the browser issues the subresource itself;
 *   * `<iframe src="/api/…">` — likewise, and it is a document load;
 *   * `<a href="/api/…" download>` — a navigation, not a fetch.
 *
 * On a session that has never entered a shared record this is invisible: the
 * fence exempts `record_epoch = 0`, so a headerless request is served exactly
 * as it always was. The moment the session enters or leaves a shared record the
 * epoch moves, the exemption ends, and every one of those three gets
 * `403 sharing.access.denied` — permanently, because nothing about them will
 * ever start sending a header. A thumbnail that silently stops rendering after
 * somebody visits a shared record is the shape of the bug.
 *
 * The fix shape already existed in the repository before this guard did:
 * `src/components/documents/document-ai-transport.ts` reaches
 * `/api/documents/inbound/{id}/original` through `apiFetchRaw` and turns the
 * blob into a `File`. Everything here follows it — fetch through the app
 * transport, hand the DOM an object URL, revoke it on unmount.
 *
 * ## What this matcher can and cannot see
 *
 * It resolves ONE level of local aliasing: `const src = \`/api/…\`` followed by
 * `src={src}` is caught, because that is the shape the real offenders had and a
 * matcher that only read inline literals would have found two of the six and
 * reported success. It does NOT trace a path built by a helper, assembled
 * across two hops, or returned from a hook.
 *
 * It also only knows the routes it can RESOLVE. A path whose route module it
 * cannot find is reported separately rather than silently passing, because an
 * unresolvable path is the one case where a green result would mean nothing.
 *
 * ### The blind spots, named
 *
 * Every one of these issues a browser request that carries no record-session
 * assertion, and none of them is matched here. They are written down rather
 * than matched because each is either absent from the tree today or costs more
 * to detect than it currently buys — but a future offender in any of these
 * shapes SLIPS this guard, and that is the thing to know before trusting a
 * green run:
 *
 *   * `srcSet` on an `<img>` / `<source>`, and `poster` on a `<video>`;
 *   * `<object data=…>` and `<embed src=…>`;
 *   * `<form action="/api/…">`, which navigates on submit;
 *   * `window.open("/api/…")`;
 *   * `navigator.sendBeacon("/api/…")`, which is fire-and-forget and cannot
 *     carry a custom header at all;
 *   * a CSS `url("/api/…")` in a style attribute, a styled component, or a
 *     stylesheet;
 *   * props SPREAD onto an element (`<img {...props} />`) where the path
 *     arrives from a caller;
 *   * anything outside `src/components` and `src/app` — those are the only two
 *     trees walked.
 *
 * The `element.src = "/api/…"` ASSIGNMENT form IS matched, because it is cheap
 * and the tree already contains one (`umami-script.tsx`, an unfenced route, so
 * no offender today — but it is proof the shape occurs here).
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");
const API_ROOT = join(SRC, "app", "api");

/** Client-side trees. `src/app/api` is the server end and is excluded. */
const CLIENT_ROOTS = [join(SRC, "components"), join(SRC, "app")];

const SKIP_DIRS = new Set([
  "__tests__",
  "__mocks__",
  "node_modules",
  ".next",
  "generated",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (p === API_ROOT) continue;
      walk(p, out);
    } else if (
      (name.endsWith(".ts") || name.endsWith(".tsx")) &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".test.tsx")
    ) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Resolve an `/api/...` path template to its route module.
 *
 * `${…}` segments match any `[param]` directory, which is how
 * `/api/documents/inbound/${id}/thumbnail` finds
 * `src/app/api/documents/inbound/[id]/thumbnail/route.ts`. Query strings and
 * trailing fragments are dropped before matching.
 */
function resolveRouteModules(path: string): string[] {
  const clean = path.split(/[?#]/)[0];
  const segments = clean
    .replace(/^\/api\//, "")
    .split("/")
    .filter((s) => s.length > 0);

  let dirs = [API_ROOT];
  for (const segment of segments) {
    const templated = segment.includes("${");
    const next: string[] = [];
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      if (!templated && existsSync(join(dir, segment))) {
        next.push(join(dir, segment));
        continue;
      }
      // A templated segment is a WILDCARD over every child directory, literal
      // and dynamic alike. `${id}` finds `[id]`; `${provider}` finds
      // `withings`, `fitbit`, `whoop`, `google-health`. Taking only the
      // dynamic children would have silently dropped the second shape, and a
      // path that resolves to nothing reads as "no fenced route here".
      if (!templated) continue;
      for (const child of readdirSync(dir)) {
        const p = join(dir, child);
        if (statSync(p).isDirectory()) next.push(p);
      }
    }
    dirs = next;
  }
  return dirs
    .map((dir) => join(dir, "route.ts"))
    .filter((module) => existsSync(module));
}

/** Does this route resolve a RECORD, and therefore consult the fence? */
function isFenced(routeModule: string): boolean {
  const src = readFileSync(routeModule, "utf8");
  return (
    /\brequireRecordAuth\s*\(/.test(src) ||
    /\brequireGuardianAuth\s*\(/.test(src)
  );
}

interface Reference {
  file: string;
  line: number;
  sink: string;
  path: string;
}

const API_LITERAL = /^[`"']((?:\/api\/)[^`"']*)[`"']$/;

/**
 * Every `/api/...` path handed to a headerless transport in one file.
 *
 * Sinks: `src=`, `href=`, and any `window.location` write. Each is resolved
 * against a one-level alias map built from the file's own
 * `const NAME = "/api/…"` declarations.
 */
function headerlessReferences(file: string, source: string): Reference[] {
  const aliases = new Map<string, string>();
  // `const NAME = "/api/…"`, and the ternary form
  // `const NAME = cond ? \`/api/…\` : "#"` that the download links use. Both
  // are one hop, which is the documented limit of this resolution.
  for (const m of source.matchAll(
    /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*[^;\n]*?([`"'])(\/api\/[^`"']*)\2/g,
  )) {
    if (!aliases.has(m[1])) aliases.set(m[1], m[3]);
  }

  const found: Reference[] = [];
  const record = (index: number, sink: string, raw: string) => {
    const trimmed = raw.trim();
    const literal = API_LITERAL.exec(trimmed);
    const path = literal ? literal[1] : (aliases.get(trimmed) ?? null);
    if (path === null) return;
    found.push({
      file,
      line: source.slice(0, index).split("\n").length,
      sink,
      path,
    });
  };

  // `src={expr}` / `src="literal"` and the same for `href`.
  //
  // The expression container is read with a brace COUNTER, not a
  // `[^}]*` class: a template literal like `` `/api/x/${id}/y` `` contains a
  // `}` of its own, and a non-counting matcher truncates at it and then fails
  // to recognise the literal at all. That is how the first draft of this guard
  // found two of six offenders and reported success.
  for (const m of source.matchAll(/\b(src|href)=/g)) {
    const start = m.index + m[0].length;
    const ch = source[start];
    if (ch === "{") {
      let depth = 0;
      let end = start;
      for (; end < source.length; end++) {
        if (source[end] === "{") depth++;
        else if (source[end] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      record(m.index, m[1], source.slice(start + 1, end));
    } else if (ch === '"' || ch === "'" || ch === "`") {
      const end = source.indexOf(ch, start + 1);
      if (end !== -1) record(m.index, m[1], source.slice(start, end + 1));
    }
  }
  // Any `window.location` write or navigation.
  for (const m of source.matchAll(
    /window\.location(?:\.href)?\s*=\s*([^;\n]+)|window\.location\.(?:assign|replace)\(\s*([^)\n]+)\)/g,
  )) {
    record(m.index, "window.location", m[1] ?? m[2] ?? "");
  }
  // `loadDocument(path)` (`src/lib/navigation/load-document.ts`) is a
  // `window.location.assign` behind a name, so it is the same sink. Without
  // this the connect and sign-in hand-offs that moved onto it would drop out
  // of view while the guard kept passing.
  for (const m of source.matchAll(/\bloadDocument\(\s*([^)\n]+)\)/g)) {
    record(m.index, "loadDocument", m[1]);
  }
  // The imperative form: `el.src = "/api/…"`. A JSX attribute is the common
  // shape and the one the real offenders had, but a script or image built in
  // an effect issues exactly the same headerless request — and the tree
  // already contains that shape, so this is not a hypothetical.
  for (const m of source.matchAll(/\.\s*(src|href)\s*=\s*([^;\n]+)/g)) {
    record(m.index, `.${m[1]} =`, m[2]);
  }
  return found;
}

describe("no headerless browser transport reaches a fenced route", () => {
  const files = CLIENT_ROOTS.flatMap((root) => walk(root));
  const references = files.flatMap((file) =>
    headerlessReferences(
      file.slice(SRC.length + 1),
      stripComments(readFileSync(file, "utf8")),
    ),
  );

  it("finds a plausible client tree and a plausible set of references", () => {
    // Non-zero proof, twice: a walk that found nothing, or a matcher that
    // matched nothing, would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(200);
    expect(references.length).toBeGreaterThan(3);
  });

  it("resolves every referenced /api path to a route module", () => {
    // An unresolvable path is the one case where a green result would mean
    // nothing at all, so it fails loudly rather than being skipped.
    const unresolved = references.filter(
      (r) => resolveRouteModules(r.path).length === 0,
    );
    expect(unresolved.map((r) => `${r.file}:${r.line} → ${r.path}`)).toEqual(
      [],
    );
  });

  it("matches the imperative `.src =` form, not only JSX attributes", () => {
    // A new matcher that matches nothing is a check that cannot fail, so it is
    // anchored to a real occurrence: the monitoring script builds its element
    // in an effect and assigns `.src`. That route is UNFENCED, so it is not an
    // offender — which is exactly why it makes a safe anchor, and why this leg
    // asserts the reference is SEEN rather than that it is refused.
    const assignments = references.filter((r) => r.sink === ".src =");
    expect(assignments.length).toBeGreaterThan(0);
    expect(assignments.map((r) => r.path)).toContain(
      "/api/monitoring/umami-script",
    );
    expect(
      resolveRouteModules("/api/monitoring/umami-script").some(isFenced),
    ).toBe(false);
  });

  it("resolves a known fenced route, so the fenced check is live", () => {
    // Without this the leg below would pass for an `isFenced` that always
    // returned false.
    const thumbnail = resolveRouteModules(
      "/api/documents/inbound/${id}/thumbnail",
    );
    expect(thumbnail).toHaveLength(1);
    expect(isFenced(thumbnail[0])).toBe(true);
    const connect = resolveRouteModules("/api/withings/connect");
    expect(connect).toHaveLength(1);
    expect(isFenced(connect[0])).toBe(false);
    // The wildcard shape resolves to several real routes, none of them fenced.
    const providers = resolveRouteModules("/api/${provider}/connect");
    expect(providers.length).toBeGreaterThan(2);
    expect(providers.some(isFenced)).toBe(false);
  });

  it("names no fenced route in a src=, href= or window.location sink", () => {
    const offenders = references.filter((r) =>
      resolveRouteModules(r.path).some(isFenced),
    );

    if (offenders.length > 0) {
      const report = offenders
        .map((o) => `  ❌ ${o.file}:${o.line} — ${o.sink}= ${o.path}`)
        .join("\n");
      throw new Error(
        `${offenders.length} headerless reference(s) to a record-fenced route:\n${report}\n\n` +
          "These cannot carry the record-session fence headers, so they are refused with " +
          "403 sharing.access.denied on any session that has entered or left a shared " +
          "record. Fetch through `apiFetchRaw` and hand the DOM an object URL — see " +
          "`src/components/documents/document-ai-transport.ts` for the shape, and revoke " +
          "the URL when the component unmounts.",
      );
    }
  });
});
