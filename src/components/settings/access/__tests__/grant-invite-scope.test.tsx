/**
 * The consent surface for a narrowed grant.
 *
 * What an SSR render can prove and what it cannot, stated up front because it
 * shapes every assertion below. It can prove that a control exists, that a
 * sentence sits beside it, that a default is the default, and that a level
 * that must not offer scope does not render one. It CANNOT prove that the
 * sections somebody ticks reach the server: there is no click here, so the
 * submit path never runs. That half is `e2e/account-sharing.spec.ts` (which
 * reads the posted body) and `src/app/api/account/grants/__tests__/` (which
 * reads the written row).
 *
 * The interactive states are reached by rendering the card with the state
 * already in it — React's `useState` initialiser is not reachable from a
 * static render, so the expanded state is asserted through the one branch a
 * static render CAN see: Manage, whose collapse is unconditional. Everything
 * the expanded panel says is pinned in the bundle test at the bottom, which is
 * where a dropped honesty sentence would actually be dropped.
 *
 * Mutation checks, run and recorded in the stream's report:
 *   - render the eight checkboxes unconditionally (drop the `narrowed` gate) →
 *     "the entire record is the default and the sections stay closed" goes red;
 *   - render the scope fieldset for MANAGE too → "manage collapses the whole
 *     question" goes red.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { I18nProvider } from "@/lib/i18n/context";

vi.mock("@/lib/queries/use-account-grants", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/queries/use-account-grants")>();
  return {
    ...actual,
    useInviteGrant: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

import { GrantInviteCard, resolveInviteScope } from "../grant-invite-card";

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("choosing what a grant opens", () => {
  it("asks the scope question for the two levels it applies to", () => {
    const html = render(<GrantInviteCard />);
    expect(html).toContain('data-slot="grant-invite-scope"');
    expect(html).toContain('data-scope="all"');
    expect(html).toContain('data-scope="some"');
  });

  it("makes the entire record the default and leaves the sections closed", () => {
    // The shape of the whole design: narrowing is an act somebody chooses, so
    // the default costs nothing and the eight checkboxes are not on screen
    // until they are wanted. A form that showed them all at once would make
    // the common case look like unfinished work.
    const html = render(<GrantInviteCard />);
    expect(html).toContain('data-scope="all" data-selected="true"');
    expect(html).toContain('data-scope="some" data-selected="false"');
    expect(html).not.toContain('data-slot="grant-invite-sections"');
    expect(html).not.toContain('data-slot="grant-invite-section"');
  });

  it("says nothing about sections before the level is decided", () => {
    // The honesty sentences belong to the decision, not to the page. Rendered
    // unconditionally they would be a disclaimer somebody scrolls past; they
    // appear where the sections do.
    const html = render(<GrantInviteCard />);
    expect(html).not.toContain('data-slot="grant-invite-scope-leak"');
    expect(html).not.toContain('data-slot="grant-invite-scope-aggregates"');
  });
});

describe("the bundle behind the expanded state", () => {
  // What the panel says is copy, and copy is where this silently rots. The
  // strings are asserted against the shipped English bundle rather than
  // against a render, so a key that stops being written is caught here and a
  // key that stops being READ is caught by the i18n reverse-coverage guard.
  const en = JSON.parse(
    readFileSync(join(process.cwd(), "messages/en.json"), "utf8"),
  ) as { recordSharing: Record<string, Record<string, unknown>> };
  const invite = en.recordSharing.invite as Record<string, string>;
  const sections = en.recordSharing.section as Record<
    string,
    { label: string; detail: string }
  >;

  it("names all eight sections with a sentence each", () => {
    // Eight, not seven and not nine: the vocabulary is closed, and a section
    // in the enum without copy would render a blank line on a consent screen.
    expect(Object.keys(sections).sort()).toEqual(
      [
        "cycle",
        "documents",
        "illness",
        "labs",
        "measurements",
        "medications",
        "mind",
        "profile",
      ].sort(),
    );
    for (const [key, entry] of Object.entries(sections)) {
      expect(entry.label.length, key).toBeGreaterThan(2);
      // A sentence, not a repeat of the label: the names are the product's
      // own boundaries and mean nothing to somebody who did not draw them.
      expect(entry.detail.length, key).toBeGreaterThan(entry.label.length);
    }
  });

  it("keeps both honest limits, in the words that make them honest", () => {
    // Leakage: a section shares everything written inside it, notes included.
    expect(invite.scopeLeakNote).toContain(
      "Sharing a section shares everything written in it",
    );
    // And the aggregates a narrowed grant simply does not get. Saying this
    // after the fact is a support ticket; saying it here is consent.
    expect(invite.scopeAggregateNote).toContain(
      "only appear when the entire record is shared",
    );
  });

  it("warns about the one section whose name does not bound its contents", () => {
    expect(invite.scopeDocumentsNote).toContain("can contain anything");
  });

  it("states the manage fence in the invitation copy itself", () => {
    // Not in a tooltip and not in the docs: on the label, where somebody is
    // deciding.
    expect(invite.accessManageCapability).toContain(
      "add, change and remove entries",
    );
    expect(invite.accessManageCapability).toContain(
      "including ones you entered yourself",
    );
    expect(invite.accessManageCapability).toContain("They cannot change your");
  });
});

describe("what the form would send", () => {
  // The interactive states a static render cannot reach, exercised through
  // the pure function the form itself calls. This is the half that matters:
  // the copy above says what a person is agreeing to, this says what leaves
  // the browser.

  it("sends nothing scoped for the whole record", () => {
    expect(
      resolveInviteScope({ access: "READ", narrowed: false, sections: [] }),
    ).toEqual({ mode: "all", scope: null, blocked: false });
  });

  it("sends the picked sections in reading order, not clicking order", () => {
    // The state is a click log. Two owners who picked the same three sections
    // in a different sequence must write rows that look the same, or a diff of
    // two grants means nothing.
    const choice = resolveInviteScope({
      access: "WRITE",
      narrowed: true,
      sections: ["documents", "labs", "measurements"],
    });
    expect(choice.mode).toBe("pick");
    expect(choice.scope).toEqual(["measurements", "labs", "documents"]);
    expect(choice.blocked).toBe(false);
  });

  it("refuses to send a narrowed invitation with nothing picked", () => {
    // A grant that opens nothing is not a narrow grant, it is a mistake
    // wearing one. The server refuses it; the form does not ask.
    const choice = resolveInviteScope({
      access: "READ",
      narrowed: true,
      sections: [],
    });
    expect(choice.blocked).toBe(true);
    expect(choice.scope).toEqual([]);
  });

  it("never sends a scope with manage, whatever is still ticked", () => {
    // The property that needs a test rather than a comment. The checkbox state
    // survives a trip through the Manage option on purpose — somebody who
    // narrows, reads the Manage sentence and goes back should find their
    // sections intact — so "not on screen" is NOT "not in state". The level is
    // what decides, and it decides here.
    const choice = resolveInviteScope({
      access: "MANAGE",
      narrowed: true,
      sections: ["medications", "labs"],
    });
    expect(choice.mode).toBe("manage");
    expect(choice.scope).toBeNull();
    expect(choice.blocked).toBe(false);
  });

  it("carries the sentence that says why manage has no sections", () => {
    const en = JSON.parse(
      readFileSync(join(process.cwd(), "messages/en.json"), "utf8"),
    ) as { recordSharing: { invite: Record<string, string> } };
    expect(en.recordSharing.invite.scopeManageNote).toBe(
      "Manage access always covers the entire record.",
    );
    // And the consequence of gating it on a second factor, said where
    // somebody meets it rather than in an error message afterwards.
    expect(en.recordSharing.invite.manageStepUpNote).toContain("browser");
  });
});
