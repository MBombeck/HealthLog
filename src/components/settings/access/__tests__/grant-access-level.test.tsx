/**
 * The access level, on the three screens that decide it.
 *
 * What an SSR render can prove, and what it cannot, stated up front because the
 * distinction is the reason this file is shaped the way it is. It can prove
 * that a control exists, that a sentence is on the page beside it, and that a
 * row states its level before the button that accepts it. It CANNOT prove that
 * the chosen level reaches the server: there is no click here, so the submit
 * path never runs, and every assertion below stays green with the form wired
 * back to a constant. That half is the browser journey's
 * (`e2e/account-sharing.spec.ts`, which reads the posted body), and the
 * database half is `src/app/api/account/grants/__tests__/`.
 *
 * The invitation copy is asserted by its promise rather than by its wording:
 * "cannot edit or delete" is the sentence somebody's expectation is set by, and
 * a rewrite that quietly drops it should fail here.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";
import type { GrantList, GrantRow } from "@/lib/queries/use-account-grants";

const grantsRef: { value: GrantList } = { value: { given: [], received: [] } };

vi.mock("@/lib/queries/use-account-grants", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/queries/use-account-grants")>();
  return {
    ...actual,
    useInviteGrant: () => ({ mutate: vi.fn(), isPending: false }),
    useAccountGrants: () => ({
      data: grantsRef.value,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useRecordActivity: () => ({
      data: undefined,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useAcceptGrant: () => ({ mutate: vi.fn(), isPending: false }),
    useRenounceGrant: () => ({ mutate: vi.fn(), isPending: false }),
    useRevokeGrant: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

vi.mock("@/hooks/use-account-switch", () => ({
  useAccountSwitch: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { GrantInviteCard } from "../grant-invite-card";
import { GrantsReceivedCard } from "../grants-received-card";
import { revokeBody } from "../grants-given-card";

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

const BASE: GrantRow = {
  id: "g1",
  account: { id: "acct-1", username: "housemate", displayName: "Jo" },
  access: "READ",
  scope: null,
  state: "PENDING",
  invitedAt: "2026-01-02T10:00:00.000Z",
  acceptedAt: null,
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
  revokedBy: null,
};

describe("offering a level", () => {
  it("offers all three levels and preselects the narrowest", () => {
    const html = render(<GrantInviteCard />);
    expect(html).toContain('data-slot="grant-invite-access"');
    expect(html).toContain('data-access="READ"');
    expect(html).toContain('data-access="WRITE"');
    expect(html).toContain('data-access="MANAGE"');
    // The narrow level is the one somebody chooses their way out of.
    expect(html).toContain('data-access="READ" data-selected="true"');
    expect(html).toContain('data-access="WRITE" data-selected="false"');
    expect(html).toContain('data-access="MANAGE" data-selected="false"');
  });

  it("shows keyboard focus on every option the radio is hidden inside", () => {
    // The radio is `sr-only`, so the browser's own ring lands on a zero-size
    // box and tabbing through this fieldset moved an invisible selection —
    // WCAG 2.4.7, on the screen where somebody grants write access to their
    // health record. The label wears the ring instead, and `has-[:focus-visible]`
    // is what carries it from the input to the label.
    //
    // Both fieldsets are checked, not only the level one: v1.37.0 added a
    // second group of radios in the same idiom, and a group that lost the ring
    // would be the same defect shipped again one section further down.
    const html = render(<GrantInviteCard />);
    const levels = html.match(
      /<label[^>]*data-slot="grant-invite-access-option"[^>]*>/g,
    );
    const scopes = html.match(
      /<label[^>]*data-slot="grant-invite-scope-option"[^>]*>/g,
    );
    expect(levels).toHaveLength(3);
    expect(scopes).toHaveLength(2);
    for (const option of [...(levels ?? []), ...(scopes ?? [])]) {
      expect(option, option).toContain("has-[:focus-visible]:ring-2");
      expect(option, option).toContain("has-[:focus-visible]:ring-ring/50");
    }
  });

  it("says plainly that manage can change and delete what the owner wrote", () => {
    const html = render(<GrantInviteCard />);
    // The clause that separates this level from the one below it. A rewrite
    // that keeps "manage" and drops this is a rewrite that stops describing
    // a delete button.
    expect(html).toContain("add, change and remove entries in your record");
    expect(html).toContain("including ones you entered yourself");
    // And the fence, in the same breath. Consent to management is only
    // meaningful beside what management does not reach.
    expect(html).toContain("They cannot change your login");
    expect(html).toContain("who else has access");
    expect(html).toContain("You can end this at any time.");
  });

  it("says what the wider level actually does, and what it does not", () => {
    const html = render(<GrantInviteCard />);
    // The thing a person reading "write access" gets wrong.
    expect(html).toContain("cannot edit or delete anything");
    expect(html).toContain("marking a dose taken or skipped");
    // v1.36.1 — the copy named allergies, which left the admitted set before
    // this shipped, and it did so on the one screen where somebody decides who
    // may write into their health record. Assert the withdrawal too, not only
    // the presence of the rest: a consent notice that over-promises is worse
    // than one that is merely incomplete.
    expect(html).not.toContain("allergies");
    // v1.36.x — and the same again for logging a value on a tracked metric.
    // The route was admitted, the copy promised it, and no delegate could
    // reach a surface that posts one: `/custom-metrics/{id}` is not a
    // shared-record destination, so the shell answers before the form does.
    // The permission and the sentence went together.
    expect(html).not.toContain("a metric you track yourself");
    // Deferring a reminder is the capability the same request could reach and
    // delegation does not cover; the notice has to say so.
    expect(html).toContain("cannot defer one of your reminders");
    // And the narrow option still says it is narrow.
    expect(html).toContain("They cannot add or change anything.");
  });
});

describe("accepting a level", () => {
  it("states the level and what accepting it means before the button", () => {
    grantsRef.value = {
      given: [],
      received: [{ ...BASE, access: "WRITE" }],
    };
    const html = render(<GrantsReceivedCard />);

    expect(html).toContain('data-grant-access="WRITE"');
    expect(html).toContain("Can read and add entries");
    expect(html).toContain('data-slot="grant-write-consent"');
    // In document order the consent sits ahead of the control it qualifies.
    expect(html.indexOf('data-slot="grant-write-consent"')).toBeLessThan(
      html.indexOf('data-slot="grant-accept"'),
    );
  });

  it("asks a manage invitation for its own, heavier consent", () => {
    grantsRef.value = { given: [], received: [{ ...BASE, access: "MANAGE" }] };
    const html = render(<GrantsReceivedCard />);

    expect(html).toContain('data-grant-access="MANAGE"');
    // The row states the level in its own words, not the write level's.
    expect(html).toContain("change or remove what is in it");
    expect(html).toContain('data-slot="grant-manage-consent"');
    // Not the write sentence wearing a stronger adjective: a different
    // responsibility gets a different sentence.
    expect(html).not.toContain('data-slot="grant-write-consent"');
    expect(html).toContain("change or remove what is already in it");
    expect(html).toContain("recorded under your name");
    expect(html.indexOf('data-slot="grant-manage-consent"')).toBeLessThan(
      html.indexOf('data-slot="grant-accept"'),
    );
  });

  it("does not ask a read invitation for a write consent", () => {
    grantsRef.value = { given: [], received: [{ ...BASE, access: "READ" }] };
    const html = render(<GrantsReceivedCard />);
    expect(html).toContain('data-grant-access="READ"');
    expect(html).not.toContain('data-slot="grant-write-consent"');
  });

  it("stops saying it once the invitation has been answered", () => {
    // A sentence about a decision already taken is nagging, not consent.
    grantsRef.value = {
      given: [],
      received: [
        {
          ...BASE,
          access: "WRITE",
          state: "ACTIVE",
          acceptedAt: "2026-01-02T11:00:00.000Z",
        },
      ],
    };
    const html = render(<GrantsReceivedCard />);
    expect(html).not.toContain('data-slot="grant-write-consent"');
  });
});

describe("ending an access, and what it says about what was entered", () => {
  const t = (key: string, params?: Record<string, string | number>): string =>
    params ? `${key}(${JSON.stringify(params)})` : key;

  it("says nothing about entries for a grant that could not make any", () => {
    const body = revokeBody({
      t,
      access: "READ",
      name: "Jo",
      retentionDays: 90,
    });
    expect(body).toContain("recordSharing.given.revokeBody");
    expect(body).not.toContain("revokeEntriesStay");
    expect(body).not.toContain("revokeAttribution");
  });

  it("tells a write owner that the entries stay and stay attributed", () => {
    const body = revokeBody({
      t,
      access: "WRITE",
      name: "Jo",
      retentionDays: 90,
    });
    expect(body).toContain("recordSharing.given.revokeEntriesStay");
    expect(body).toContain('revokeAttribution({"days":90})');
  });

  it("tells a manage owner the same, because the question is sharper there", () => {
    // The condition is "not READ" rather than "is WRITE". A manager put things
    // in the record AND changed things in it, so "what happens to what they
    // did" is the sentence this owner most needs, and a level check that
    // listed WRITE by name would have dropped it exactly where it matters.
    const body = revokeBody({
      t,
      access: "MANAGE",
      name: "Jo",
      retentionDays: 90,
    });
    expect(body).toContain("recordSharing.given.revokeEntriesStay");
    expect(body).toContain('revokeAttribution({"days":90})');
  });

  it("omits the window rather than inventing one", () => {
    // The number is the operator's setting. A compiled-in 365 here would be
    // exactly the invented value the sentence exists to avoid.
    const body = revokeBody({ t, access: "WRITE", name: "Jo" });
    expect(body).toContain("recordSharing.given.revokeEntriesStay");
    expect(body).not.toContain("revokeAttribution");
  });
});
