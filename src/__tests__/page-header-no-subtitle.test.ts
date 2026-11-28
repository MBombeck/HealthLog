/**
 * A page has a title and no subtitle (necessity audit K1).
 *
 * `PageHeader` and `SubPageShell` no longer take a `description`, so the
 * type checker refuses a subtitle. What it cannot refuse is the same
 * sentence through the one other slot under the title: `PageHeader meta` is
 * for a fact of the record (a dose, a link's label, a greeting with the
 * person's name), and a translated string passed straight into it is copy,
 * not data. This walks every call site and refuses `meta={t(...)}`.
 *
 * What it does not catch: a translated string assigned to a variable first.
 * Review catches that; the explainer budget in `e2e/text-budgets.json` does
 * not count `meta`, so a subtitle smuggled in that way still costs nothing
 * there, which is why this guard exists at all.
 */
import { describe, expect, it } from "vitest";
import { readSourceFolder } from "./helpers/source-files";

function findCopyInMeta(source: string): string[] {
  const hits: string[] = [];
  for (const match of source.matchAll(/<(PageHeader|SubPageShell)\b/g)) {
    // The opening tag ends at the first `>` outside braces.
    let depth = 0;
    let end = match.index + match[0].length;
    for (; end < source.length; end++) {
      const ch = source[end];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) break;
    }
    // Only the tag's own attributes: a nested element inside a prop (a
    // confirm dialog in `actions`) has its own `description`. Each braced
    // value is reduced to whether it starts with a `t(` call.
    let tag = "";
    let level = 0;
    let value = "";
    for (const ch of source.slice(match.index, end)) {
      if (ch === "{") {
        if (level === 0) value = "";
        level++;
        if (level === 1) {
          tag += "{";
          continue;
        }
      } else if (ch === "}") {
        level--;
        if (level === 0) {
          tag += (/^\s*t\(/.test(value) ? "t(" : "") + "}";
          continue;
        }
      }
      if (level === 0) tag += ch;
      else value += ch;
    }
    if (/\bmeta=\{\s*t\(/.test(tag)) hits.push(`${match[1]} meta={t(...)}`);
    if (/\bdescription=/.test(tag)) hits.push(`${match[1]} description=`);
  }
  return hits;
}

describe("no page subtitle", () => {
  it("finds copy in the meta slot and a description on a fixture", () => {
    expect(
      findCopyInMeta(
        `<PageHeader title={t("a.title")} meta={t("a.subtitle")} />`,
      ),
    ).toEqual(["PageHeader meta={t(...)}"]);
    expect(
      findCopyInMeta(
        `<SubPageShell title="x" description="Says the title again">`,
      ),
    ).toEqual(["SubPageShell description="]);
    expect(findCopyInMeta(`<PageHeader title={name} meta={dose} />`)).toEqual(
      [],
    );
  });

  it("no call site passes copy under a page title", () => {
    const files = (
      [
        ["src/components", 900],
        ["src/app", 120],
      ] as const
    ).flatMap(([dir, floor]) =>
      readSourceFolder(dir, {
        floor,
        extensions: [".tsx"],
        include: (rel) => !rel.includes("__tests__/"),
      }).map(([rel, source]) => ({ path: `${dir}/${rel}`, source })),
    );
    const offenders: string[] = [];
    let callSites = 0;
    for (const { path, source } of files) {
      callSites += (source.match(/<(PageHeader|SubPageShell)\b/g) ?? []).length;
      for (const hit of findCopyInMeta(source))
        offenders.push(`${path}: ${hit}`);
    }
    // A walk that found no headers would pass for the wrong reason.
    expect(callSites).toBeGreaterThan(60);
    expect(offenders).toEqual([]);
  });
});
