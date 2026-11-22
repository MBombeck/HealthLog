import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { Bell } from "lucide-react";

import { I18nProvider } from "@/lib/i18n/context";
import { PageHeader } from "@/components/ui/page-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { requireFloor } from "@/__tests__/helpers/source-files";

/**
 * Settings + Admin read as one surface. These pin the parts of that claim
 * that can be checked exactly:
 *
 *   1. the header→body step is owned by `SettingsCard`, so a call site can
 *      neither re-declare it nor drift from it;
 *   2. the card header's description slot carries no vertical rhythm — the
 *      licence call sites used to stack explainer paragraphs into a muted
 *      `text-xs` slot;
 *   3. the action row has one shape, and its one documented exception
 *      (a card whose only actions are links out) is spelled as a prop;
 *   4. `pl-7` — the off-scale body gutter that broke wherever two
 *      neighbouring cards disagreed about it — stays gone;
 *   5. both consoles render their page heading through `PageHeader`, so
 *      Settings and Admin cannot drift a step apart from the module pages
 *      or from each other.
 */

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      walk(full, out);
    } else if (entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

describe("SettingsCard — the container owns the rhythm", () => {
  it("paints the gap-based shell, not a call-site margin", () => {
    const html = render(<SettingsCard>body</SettingsCard>);
    expect(html).toContain("flex flex-col gap-4");
    expect(html).toContain("p-4");
    expect(html).toContain("md:p-6");
  });

  it("gives the semantic-landmark variant the same rhythm", () => {
    const html = render(<SettingsCard as="section">body</SettingsCard>);
    expect(html).toContain("<section");
    expect(html).toContain("flex flex-col gap-4");
  });

  it("still lets a dense card override the gap on the card itself", () => {
    const html = render(<SettingsCard className="gap-2">body</SettingsCard>);
    expect(html).toContain("gap-2");
  });

  it("drops the gap as well as the padding on a flush ledger card", () => {
    // Dropping only the padding leaves the card's own gap standing between
    // the rows as dead space the first row does not have. Both breakpoints
    // are named because the `<Card>` primitive carries a `md:` gap that a
    // bare `gap-0` loses to.
    const html = render(<SettingsCard flush>rows</SettingsCard>);
    expect(html).toContain("gap-0");
    expect(html).toContain("md:gap-0");
    expect(html).toContain("p-0");
    expect(html).toContain("md:p-0");
    expect(html).not.toMatch(/class="[^"]*\bgap-4\b/);
    expect(html).not.toMatch(/class="[^"]*\bp-4\b/);
  });
});

describe("SettingsCardHeader — one description sentence, one text run", () => {
  it("renders the description without any vertical rhythm of its own", () => {
    const html = render(
      <SettingsCardHeader icon={Bell} title="Channels" description="One." />,
    );
    // The slot is muted meta at the size floor…
    expect(html).toContain("text-muted-foreground text-xs");
    // …and carries no `space-y-*`, so a stack of <p>s cannot read as prose.
    const slot = html.slice(html.indexOf("text-muted-foreground text-xs"));
    expect(slot.slice(0, 60)).not.toMatch(/space-y-/);
  });

  it("keeps the title in the foreground tier at one size", () => {
    const html = render(<SettingsCardHeader icon={Bell} title="Channels" />);
    expect(html).toMatch(/<h2[^>]*class="text-lg font-semibold"/);
  });

  it("names the description slot so a browser test can target it", () => {
    // A spec that asserted the sentence's bytes broke on the text diet while
    // the thing it was actually about — the card rendering its explainer —
    // never changed. This attribute is the stable target that replaced it.
    const html = render(
      <SettingsCardHeader icon={Bell} title="Channels" description="One." />,
    );
    expect(html).toContain('data-slot="settings-card-description"');
  });
});

describe("SettingsCardActions — one row, one shape", () => {
  it("puts the row at the trailing edge by default", () => {
    const html = render(
      <SettingsCardActions>
        <button>Save</button>
      </SettingsCardActions>,
    );
    expect(html).toContain('data-slot="settings-card-actions"');
    expect(html).toContain("justify-end");
  });

  it("spells the link-row exception as a prop rather than a local class", () => {
    const html = render(
      <SettingsCardActions align="start">
        <a href="/x">Open</a>
      </SettingsCardActions>,
    );
    expect(html).toContain("justify-start");
    expect(html).not.toContain("justify-end");
  });

  it("sets its buttons' height and width itself", () => {
    // 44 px on a phone and under a finger, 36 px on a wider screen with a
    // mouse, never full width. The selectors reach a button through the
    // attributes it always carries, so they outrank a class it brings. What
    // they do in a browser is `card-actions.browser.test.tsx`.
    const html = render(
      <SettingsCardActions>
        <button data-slot="button">Save</button>
      </SettingsCardActions>,
    );
    const button =
      "[&amp;_:is(button,a)[data-variant][data-size]:not([data-size^=icon])]";
    expect(html).toContain(`${button}:min-h-11`);
    expect(html).toContain(`sm:pointer-fine:${button}:min-h-9`);
    expect(html).toContain(`${button}:w-auto`);
  });

  it("keeps a leading control on the left and the actions on the right", () => {
    const html = render(
      <SettingsCardActions leading={<button>Details</button>}>
        <button data-slot="button">Sync</button>
      </SettingsCardActions>,
    );
    expect(html).toContain("justify-between");
    expect(html.indexOf("Details")).toBeLessThan(html.indexOf("Sync"));
    expect(html).toMatch(/ml-auto[^"]*justify-end/);
  });
});

describe("PageHeader — the one page heading, including the shells", () => {
  it("renders the explainer in the muted tier", () => {
    const html = render(<PageHeader title="Settings" description="Yours." />);
    expect(html).toMatch(/<p class="text-muted-foreground text-sm">Yours\./);
  });

  it("renders a second copy as a heading role, never a second <h1>", () => {
    const html = render(
      <PageHeader headingAs="div" title="Settings" description="Yours." />,
    );
    expect(html).not.toContain("<h1");
    expect(html).toContain('role="heading"');
    expect(html).toContain('aria-level="1"');
  });

  it("never truncates the explainer", () => {
    const html = render(
      <PageHeader title="Medications" description="Schedules and reminders." />,
    );
    expect(html).not.toContain("truncate");
  });
});

describe("the Settings and Admin shells route their heading through PageHeader", () => {
  for (const shell of [
    join("src", "components", "settings", "settings-shell.tsx"),
    join("src", "components", "admin", "admin-shell.tsx"),
  ]) {
    it(`${shell} has no hand-rolled H1 block`, () => {
      const source = readFileSync(join(ROOT, shell), "utf8");
      expect(source).toContain("<PageHeader");
      // The hand-rolled copies were a literal `<h1 className="text-2xl …">`
      // plus a `role="heading"` div beside it. Both belong to the primitive.
      const code = source
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("//"))
        .join("\n");
      expect(code).not.toMatch(/<h1\b/);
      expect(code).not.toMatch(/role="heading"/);
    });
  }
});

describe("the abolished body gutter stays abolished", () => {
  it("has no `pl-7` left under Settings or Admin", () => {
    const offenders: string[] = [];
    for (const [dir, floor] of [
      ["settings", 130],
      ["admin", 30],
    ] as const) {
      const files = walk(join(ROOT, "src", "components", dir));
      for (const file of requireFloor(`${dir} components`, files, floor)) {
        const source = readFileSync(file, "utf8");
        for (const [i, line] of source.split("\n").entries()) {
          // Comments may name the class they retired; class strings may not.
          // Skipping any line that CONTAINS `//` was too coarse — a class
          // string on the same line as a URL (`https://…`) would have been
          // waved through. Only the part of the line after a line-comment
          // marker is exempt, and a marker inside a string is not one.
          if (line.trimStart().startsWith("*")) continue;
          const marker = line.indexOf("//");
          const code =
            marker === -1 || /["'`]/.test(line.slice(0, marker))
              ? line
              : line.slice(0, marker);
          if (/\bpl-7\b/.test(code)) {
            offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
