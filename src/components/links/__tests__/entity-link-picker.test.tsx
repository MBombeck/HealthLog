import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FolderOpen } from "lucide-react";

import { I18nProvider } from "@/lib/i18n/context";
import {
  EntityLinkPicker,
  filterOptions,
  groupOptions,
  restoreLink,
  toggleAll,
  type EntityLinkOption,
} from "../entity-link-picker";

const OPTIONS: EntityLinkOption[] = [
  {
    id: "a",
    label: "LDL cholesterol",
    meta: "mg/dL",
    dateLabel: "12.05.2026",
    group: { key: "2026-05-12|Lipids", label: "Lipids · 12.05.2026" },
  },
  {
    id: "b",
    label: "HDL cholesterol",
    meta: "mg/dL",
    dateLabel: "12.05.2026",
    group: { key: "2026-05-12|Lipids", label: "Lipids · 12.05.2026" },
  },
  {
    id: "c",
    label: "Glucose",
    meta: "mg/dL",
    dateLabel: "03.02.2026",
    group: { key: "2026-02-03|Metabolic", label: "Metabolic · 03.02.2026" },
  },
];

describe("filterOptions", () => {
  it("returns everything for an empty term", () => {
    expect(filterOptions(OPTIONS, "")).toHaveLength(3);
    expect(filterOptions(OPTIONS, "   ")).toHaveLength(3);
  });

  it("matches the label, case-insensitively", () => {
    const hits = filterOptions(OPTIONS, "glucose");
    expect(hits.map((o) => o.id)).toEqual(["c"]);
  });

  it("matches the group heading, so a panel search finds its members", () => {
    const hits = filterOptions(OPTIONS, "lipids");
    expect(hits.map((o) => o.id)).toEqual(["a", "b"]);
  });

  it("matches the date and the meta line", () => {
    expect(filterOptions(OPTIONS, "03.02").map((o) => o.id)).toEqual(["c"]);
    expect(filterOptions(OPTIONS, "mg/dl")).toHaveLength(3);
  });
});

describe("groupOptions", () => {
  it("collapses options into ordered groups, first-seen order", () => {
    const groups = groupOptions(OPTIONS);
    expect(groups.map((g) => g.label)).toEqual([
      "Lipids · 12.05.2026",
      "Metabolic · 03.02.2026",
    ]);
    expect(groups[0].options.map((o) => o.id)).toEqual(["a", "b"]);
    expect(groups[1].options.map((o) => o.id)).toEqual(["c"]);
  });

  it("returns one flat, headingless group when nothing carries a group", () => {
    const flat: EntityLinkOption[] = [
      { id: "x", label: "Knee injury" },
      { id: "y", label: "Migraine" },
    ];
    const groups = groupOptions(flat);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBeNull();
    expect(groups[0].label).toBeNull();
    expect(groups[0].options).toHaveLength(2);
  });

  it("returns nothing for an empty option set", () => {
    expect(groupOptions([])).toEqual([]);
  });
});

describe("toggleAll", () => {
  it("adds the missing ids when the group is not fully selected", () => {
    expect(toggleAll(["a"], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("removes the whole group when every id is already selected", () => {
    expect(toggleAll(["a", "b", "c"], ["a", "b"])).toEqual(["c"]);
  });

  it("never duplicates an already-selected id", () => {
    expect(toggleAll(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });
});

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("<EntityLinkPicker> inline summary", () => {
  const base = {
    icon: FolderOpen,
    title: "Lab results",
    slot: "test-link",
    searchPlaceholder: "Search",
    emptyLabel: "Nothing to link",
    onChange: () => undefined,
  };

  it("shows a chip per selected option and the count badge", () => {
    const html = render(
      <EntityLinkPicker
        {...base}
        options={OPTIONS}
        pending={false}
        selected={["a", "c"]}
      />,
    );
    expect(html).toContain('data-slot="test-link-chips"');
    // One chip per selected id, labelled from the option.
    expect(html).toContain("LDL cholesterol");
    expect(html).toContain("Glucose");
    // The add button opens the sheet.
    expect(html).toContain('data-slot="test-link-add"');
  });

  it("renders the empty label when there is nothing to offer", () => {
    const html = render(
      <EntityLinkPicker {...base} options={[]} pending={false} selected={[]} />,
    );
    expect(html).toContain("Nothing to link");
    expect(html).not.toContain('data-slot="test-link-add"');
  });

  it("a failed read shows an error row with retry, never the empty label", () => {
    const html = render(
      <EntityLinkPicker
        {...base}
        options={[]}
        pending={true}
        error
        errorLabel="Could not load documents"
        onRetry={() => undefined}
        selected={[]}
      />,
    );
    expect(html).toContain('data-slot="test-link-error"');
    expect(html).toContain("Could not load documents");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("Nothing to link");
  });

  it("renders a skeleton while the options load", () => {
    const html = render(
      <EntityLinkPicker {...base} options={[]} pending={true} selected={[]} />,
    );
    expect(html).toContain('data-slot="skeleton"');
    expect(html).not.toContain("Nothing to link");
  });
});

describe("<EntityLinkPicker> chips (#1024)", () => {
  const base = {
    icon: FolderOpen,
    title: "Vaccinations",
    slot: "test-link",
    searchPlaceholder: "Search",
    emptyLabel: "Nothing to link",
    onChange: () => undefined,
    pending: false,
  };
  const DOSES: EntityLinkOption[] = [
    {
      id: "d1",
      label: "COVID-19",
      dateLabel: "12 Sep 2025",
      href: "/vaccinations?dose=d1",
    },
    { id: "d2", label: "COVID-19", dateLabel: "3 Jan 2024" },
  ];

  it("the chip itself is not the remove control", () => {
    // Clicking a chip used to unlink it: the whole chip was the button.
    const html = render(
      <EntityLinkPicker {...base} options={DOSES} selected={["d1", "d2"]} />,
    );
    expect(html).not.toMatch(/<button[^>]*data-slot="test-link-chip"/);
    // One labelled remove button per chip, separate from the label.
    const removes = html.match(
      /<button[^>]*data-slot="test-link-chip-remove"[^>]*>/g,
    );
    expect(removes).toHaveLength(2);
    expect(removes![0]).toContain('aria-label="Remove COVID-19, 12 Sep 2025"');
  });

  it("two doses of the same vaccine are told apart by their date", () => {
    const html = render(
      <EntityLinkPicker {...base} options={DOSES} selected={["d1", "d2"]} />,
    );
    expect(html).toContain("12 Sep 2025");
    expect(html).toContain("3 Jan 2024");
  });

  it("a chip with a target opens the linked record", () => {
    const html = render(
      <EntityLinkPicker {...base} options={DOSES} selected={["d1", "d2"]} />,
    );
    const open = html.match(/<a[^>]*data-slot="test-link-chip-open"[^>]*>/);
    expect(open?.[0]).toContain('href="/vaccinations?dose=d1"');
    // No target, no link: the label is plain text, never a remove button.
    expect(html.match(/data-slot="test-link-chip-open"/g)).toHaveLength(1);
  });
});

describe("restoreLink", () => {
  it("puts an unlinked id back", () => {
    expect(restoreLink(["a"], "b")).toEqual(["a", "b"]);
  });

  it("never duplicates an id that is already back", () => {
    expect(restoreLink(["a", "b"], "b")).toEqual(["a", "b"]);
  });
});
