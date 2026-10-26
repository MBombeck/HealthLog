/**
 * Structural guard: every capped or paged list gets its page from one helper,
 * and every such read has a total order.
 *
 * The list routes had five answers to "is there more", and two of them lied:
 * a `hasMore` computed as `rows.length === limit` reported more on a page that
 * was exactly full, and a list cut at its `take` with no signal at all let the
 * last row read as the oldest one there is. `listPage`
 * (`src/lib/http/list-query.ts`) reads one row past the limit and says
 * exactly whether that row exists. This guard holds the tree to it:
 *
 *   1. a route that answers with `apiListSuccess` gets its cap from
 *      `listPage`;
 *   2. nothing outside the two list modules calls `capRows` or `overfetch` by
 *      hand;
 *   3. a `hasMore` is never a length comparison;
 *   4. every read passed to `listPage` orders by something that ends in the
 *      row id, so a page boundary between two rows that share a sort value
 *      neither repeats one nor drops one.
 *
 * The routes are derived from the tree, never listed by hand. Comments are
 * stripped first, and the planted cases at the top prove each matcher fires.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments, walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** The modules allowed to cut a list by hand: the helper and its primitive. */
const LIST_MODULES = new Set([
  "lib/api/list-cap.ts",
  "lib/http/list-query.ts",
  // The MCP tools' name for `listPage`; its reads are checked at its callers.
  "lib/mcp/capped.ts",
]);

/** The text of a call's argument list, from the `(` after `name` to its match. */
function callBodies(code: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, "g");
  for (let m = re.exec(code); m; m = re.exec(code)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    for (; i < code.length; i++) {
      const ch = code[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(code.slice(start, i + 1));
  }
  return out;
}

/** The value of the first `orderBy` in a read, up to its closing bracket. */
function orderByValue(body: string): string | null {
  const m = /\borderBy\b\s*(:)?\s*/.exec(body);
  if (!m) return null;
  // Shorthand `orderBy,` names a variable of the same name.
  if (!m[1]) return "orderBy";
  let i = m.index + m[0].length;
  const open = body[i];
  if (open !== "[" && open !== "{") {
    const ident = /^[A-Za-z_$][\w$]*/.exec(body.slice(i));
    return ident ? ident[0] : null;
  }
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  const start = i;
  for (; i < body.length; i++) {
    if (body[i] === open) depth++;
    else if (body[i] === close) {
      depth--;
      if (depth === 0) break;
    }
  }
  return body.slice(start, i + 1);
}

/** Whether an order ends in the row id, following one variable if named. */
function endsInId(order: string, file: string): boolean {
  const literal = (text: string) =>
    /^\[[\s\S]*\{\s*id\s*:\s*[^}]+\}\s*,?\s*\]$/.test(text.trim());
  if (order.startsWith("[") || order.startsWith("{")) return literal(order);
  const decl = new RegExp(
    `\\b(?:const|let)\\s+${order}\\b[^=]*=\\s*(\\[[\\s\\S]*?\\]);`,
  ).exec(file);
  return decl ? literal(decl[1]) : false;
}

/**
 * A `distinct` read returns one row per key, so ordering by that key alone is
 * already total: `distinct: ["analyte"]` with `orderBy: { analyte: "asc" }`.
 */
function ordersByDistinctKey(body: string, order: string): boolean {
  const distinct = /\bdistinct\s*:\s*\[\s*["'](\w+)["']\s*\]/.exec(body);
  if (!distinct) return false;
  return new RegExp(`^\\{\\s*${distinct[1]}\\s*:[^,}]+\\}$`).test(order.trim());
}

describe("capped lists go through listPage", () => {
  const files = walkSourceFiles(SRC, { floor: 3000 }).filter(
    (file) =>
      !file.startsWith("generated/") &&
      !file.includes("__tests__/") &&
      !/\.test\.tsx?$/.test(file),
  );
  const read = (file: string) =>
    stripComments(readFileSync(join(SRC, file), "utf8"));
  const routes = files.filter((f) => /^app\/api\/.+\/route\.tsx?$/.test(f));

  it("the matchers fire on planted sources", () => {
    const handRolled = `
      const found = await prisma.allergy.findMany({ take: overfetch(limit) });
      const { rows, cap } = capRows(found, limit);
      return apiListSuccess(rows, cap);`;
    expect(/\bcapRows\s*\(/.test(handRolled)).toBe(true);
    expect(/\blistPage\s*\(/.test(handRolled)).toBe(false);

    expect(
      /\bhasMore\s*:[^,\n]*\.length\b/.test(
        "hasMore: rows.length === q.limit,",
      ),
    ).toBe(true);
    expect(
      /\bhasMore\s*:[^,\n]*\.length\b/.test("hasMore: cap.truncated,"),
    ).toBe(false);

    const noTiebreak = `listPage(limit, (take) =>
      prisma.x.findMany({ orderBy: { createdAt: "desc" }, take }))`;
    const [body] = callBodies(noTiebreak, "listPage");
    expect(endsInId(orderByValue(body)!, noTiebreak)).toBe(false);

    const tiebreak = `listPage(limit, (take) =>
      prisma.x.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], take }))`;
    const [good] = callBodies(tiebreak, "listPage");
    expect(endsInId(orderByValue(good)!, tiebreak)).toBe(true);

    // A shorthand `orderBy` resolves through its declaration.
    const viaVariable = `const orderBy: X[] = [primaryOrder, { id: order }];
      listPage(limit, (take) => prisma.x.findMany({ where, orderBy, take }))`;
    const [short] = callBodies(viaVariable, "listPage");
    expect(endsInId(orderByValue(short)!, viaVariable)).toBe(true);
    // A distinct read is ordered whole by its own key.
    const distinctRead = `listPage(limit, (take) =>
      prisma.x.findMany({ distinct: ["analyte"], orderBy: { analyte: "asc" }, take }))`;
    const [dist] = callBodies(distinctRead, "listPage");
    expect(ordersByDistinctKey(dist, orderByValue(dist)!)).toBe(true);
    expect(ordersByDistinctKey(dist, '{ createdAt: "desc" }')).toBe(false);
    const viaBadVariable = `const orderBy = [primaryOrder];
      listPage(limit, (take) => prisma.x.findMany({ where, orderBy, take }))`;
    const [bad] = callBodies(viaBadVariable, "listPage");
    expect(endsInId(orderByValue(bad)!, viaBadVariable)).toBe(false);
  });

  it("finds the capped routes", () => {
    const capped = routes.filter((f) => /\bapiListSuccess\s*\(/.test(read(f)));
    expect(capped.length).toBeGreaterThanOrEqual(15);
  });

  it("every route answering a capped list gets its cap from listPage", () => {
    const unbound = routes.filter((f) => {
      const code = read(f);
      return (
        /\bapiListSuccess\s*\(/.test(code) && !/\blistPage\s*\(/.test(code)
      );
    });
    expect(unbound).toEqual([]);
  });

  it("nothing cuts a list by hand outside the list modules", () => {
    const handRolled = files.filter(
      (f) =>
        !LIST_MODULES.has(f) && /\b(?:capRows|overfetch)\s*\(/.test(read(f)),
    );
    expect(handRolled).toEqual([]);
  });

  it("no hasMore is a length comparison", () => {
    const guessed = routes.filter((f) =>
      /\bhasMore\s*:[^,\n]*\.length\b/.test(read(f)),
    );
    expect(guessed).toEqual([]);
  });

  it("every listPage or capped read orders by something that ends in the row id", () => {
    const unordered: string[] = [];
    let reads = 0;
    for (const f of files) {
      if (LIST_MODULES.has(f)) continue;
      const code = read(f);
      for (const body of [
        ...callBodies(code, "listPage"),
        ...callBodies(code, "capped"),
      ]) {
        reads += 1;
        const order = orderByValue(body);
        if (
          !order ||
          !(endsInId(order, code) || ordersByDistinctKey(body, order))
        ) {
          unordered.push(f);
        }
      }
    }
    expect(reads).toBeGreaterThanOrEqual(18);
    expect(unordered).toEqual([]);
  });
});
