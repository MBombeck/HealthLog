/**
 * A failed read draws a read-failure primitive, and draws it the right way.
 *
 * Two shapes kept coming back beside the primitives:
 *
 *  - A read's `isError` branch rendering its own markup: a bare
 *    `text-destructive` paragraph with no retry, a muted line that reads as
 *    "still learning", a hand-rolled row. None of them knows an ended session
 *    from a refusal, which is the decision `QueryErrorRow`, `QueryErrorCard`
 *    and `ChartErrorState` make from the error.
 *  - A `QueryErrorRow` with its own frame inside a card that already draws
 *    one, a card inside a card. Inside a card body the row is `inset`.
 *
 * Both readers are lexical. A read is a hook call (`const x = useFoo(` or a
 * destructure with `isError`) that is not `useMutation` and whose result is
 * never `.mutate`d; a mutation's error is inline `role="alert"` text by the
 * standards, so it is left alone. The branch is the text after `isError … ?`
 * or `&&` up to the next `) : `. Nesting is the count of card tags opened and
 * not closed before the row. Each reader is checked against a fixture of the
 * shape it refuses, and the tree must yield a floor of matches, so a matcher
 * that stops finding anything fails.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "generated") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test."))
      out.push(path);
  }
  return out;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PRIMITIVE = /QueryErrorRow|QueryErrorCard|ChartErrorState/;

/** Every read `isError` branch: its line and whether it hand-rolls markup. */
function readErrorBranches(
  source: string,
): Array<{ line: number; handRolled: boolean }> {
  const reads = new Set<string>();
  for (const m of source.matchAll(
    /const\s+(\w+)\s*=\s*(use\w+)\s*(?:<[^(]*>)?\(/g,
  )) {
    if (m[2] === "useMutation") continue;
    if (new RegExp(`${escape(m[1])}\\.mutate(?:Async)?\\(`).test(source))
      continue;
    reads.add(m[1]);
  }
  const alternatives = [...reads].map((v) => `${escape(v)}\\.isError`);
  const destructured = [
    ...source.matchAll(
      /const\s*\{[^}]*\bisError\b[^}]*\}\s*=\s*(use\w+)\s*(?:<[^(]*>)?\(/g,
    ),
  ].some((m) => m[1] !== "useMutation");
  if (destructured) alternatives.push("(?<![\\w.])isError");
  if (alternatives.length === 0) return [];

  const branch = new RegExp(
    `(?:${alternatives.join("|")})\\b[^\\n]*?(\\?|&&)`,
    "g",
  );
  const found: Array<{ line: number; handRolled: boolean }> = [];
  for (const m of source.matchAll(branch)) {
    if (source[m.index - 1] === "!") continue;
    const body = source.slice(
      m.index + m[0].length,
      m.index + m[0].length + 500,
    );
    const arm = body.split(") : ")[0];
    found.push({
      line: source.slice(0, m.index).split("\n").length,
      handRolled:
        !PRIMITIVE.test(arm) && /<(p|div|span)\b/.test(arm.slice(0, 250)),
    });
  }
  return found;
}

const CARD_TAGS = ["SettingsCard", "Card", "CardContent", "InsightSectionCard"];

/** Lines of `QueryErrorRow`s without `inset` inside an open card tag. */
function framedRowsInCards(source: string): number[] {
  const lines: number[] = [];
  for (const m of source.matchAll(/<QueryErrorRow\b([\s\S]*?)\/>/g)) {
    if (/\binset\b/.test(m[1])) continue;
    const before = source.slice(0, m.index);
    let depth = 0;
    for (const tag of CARD_TAGS) {
      depth += (before.match(new RegExp(`<${tag}(?=[\\s>])`, "g")) ?? [])
        .length;
      depth -= (before.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
      depth -= (before.match(new RegExp(`<${tag}(?=\\s)[^>]*?/>`, "g")) ?? [])
        .length;
    }
    if (depth > 0) lines.push(before.split("\n").length);
  }
  return lines;
}

/**
 * Read failures that draw their own markup on purpose, each with its reason.
 * Keyed by file, and held live by the case below: an entry whose file no
 * longer hand-rolls a branch fails rather than lingering as a blind spot.
 */
const HAND_ROLLED_BY_DESIGN = new Map<string, string>([
  [
    "components/admin/backups/restore-dialog.tsx",
    "the restore preview never blocks the restore: a failed preview states its own absence in the dialog, and names the missing key when that is why",
  ],
]);

const files = walk(SRC).map((file) => ({
  file: relative(SRC, file),
  source: readFileSync(file, "utf8"),
}));

describe("read failures render through a primitive", () => {
  it("recognises a hand-rolled read failure", () => {
    const rolled = `
      const { data, isError } = useQuery({ queryKey: k, queryFn: f });
      return isError ? (
        <p className="text-destructive text-sm">{t("x.loadError")}</p>
      ) : null;`;
    expect(readErrorBranches(rolled)).toEqual([{ line: 3, handRolled: true }]);
    const mutation = `
      const save = useSave();
      save.mutate(body);
      return save.isError ? <p role="alert">{t("x.saveError")}</p> : null;`;
    expect(readErrorBranches(mutation)).toEqual([]);
    const primitive = `
      const list = useList();
      return list.isError ? (
        <QueryErrorRow error={list.error} onRetry={list.refetch} />
      ) : null;`;
    expect(readErrorBranches(primitive)).toEqual([
      { line: 3, handRolled: false },
    ]);
  });

  it("finds the read branches it guards", () => {
    const branches = files.flatMap(({ source }) => readErrorBranches(source));
    // About 100 at the time of writing.
    expect(branches.length).toBeGreaterThan(80);
  });

  it("never hand-rolls one beside a read", () => {
    const offenders = files.flatMap(({ file, source }) =>
      HAND_ROLLED_BY_DESIGN.has(file)
        ? []
        : readErrorBranches(source)
            .filter((b) => b.handRolled)
            .map((b) => `${file}:${b.line}`),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps every deliberate exception live", () => {
    const stale = [...HAND_ROLLED_BY_DESIGN.keys()].filter((name) => {
      const entry = files.find(({ file }) => file === name);
      return (
        !entry || !readErrorBranches(entry.source).some((b) => b.handRolled)
      );
    });
    expect(stale).toEqual([]);
  });
});

describe("an error row inside a card draws no frame of its own", () => {
  it("recognises a framed row inside a card", () => {
    expect(
      framedRowsInCards(
        `<Card>\n<CardContent>\n<QueryErrorRow error={e} onRetry={() => r()} />\n</CardContent>\n</Card>`,
      ),
    ).toEqual([3]);
    expect(
      framedRowsInCards(
        `<Card>\n</Card>\n<QueryErrorRow error={e} onRetry={() => r()} />`,
      ),
    ).toEqual([]);
  });

  it("finds inset rows in the tree, so the reader is live", () => {
    // About 40 files at the time of writing.
    const inset = files.filter(({ source }) =>
      /<QueryErrorRow\b[^/]*\binset\b/.test(source),
    );
    expect(inset.length).toBeGreaterThan(20);
  });

  it("insets every row a card already frames", () => {
    const offenders = files.flatMap(({ file, source }) =>
      framedRowsInCards(source).map((line) => `${file}:${line}`),
    );
    expect(offenders).toEqual([]);
  });
});
