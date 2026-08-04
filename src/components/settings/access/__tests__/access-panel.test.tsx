/**
 * The shared-access panel: what each row says, and what the activity view
 * admits about itself.
 *
 * SSR renders of the real cards with the reads stubbed at the hook boundary,
 * so what is asserted is the paint. The mutations (revoke, renounce, accept)
 * are proven where they can be: their invalidation contract in
 * `src/lib/queries/__tests__/account-grants-invalidation.test.ts`, their
 * confirmation gates in `src/__tests__/destructive-control-guard.test.ts`, and
 * the end-to-end click in `e2e/account-sharing.spec.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type {
  GrantList,
  GrantRow,
  RecordActivity,
} from "@/lib/queries/use-account-grants";

const grantsRef: { value: GrantList } = { value: { given: [], received: [] } };
const activityRef: { value: RecordActivity | undefined } = { value: undefined };

vi.mock("@/lib/queries/use-account-grants", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/queries/use-account-grants")>();
  return {
    ...actual,
    useAccountGrants: () => ({
      data: grantsRef.value,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useRecordActivity: () => ({
      data: activityRef.value,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useRevokeGrant: () => ({ mutate: vi.fn(), isPending: false }),
    useRenounceGrant: () => ({ mutate: vi.fn(), isPending: false }),
    useAcceptGrant: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

vi.mock("@/hooks/use-account-switch", () => ({
  useAccountSwitch: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { GrantsGivenCard } from "../grants-given-card";
import { GrantsReceivedCard } from "../grants-received-card";
import { RecordActivityCard } from "../record-activity-card";

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
  state: "ACTIVE",
  invitedAt: "2026-01-02T10:00:00.000Z",
  acceptedAt: "2026-01-02T11:00:00.000Z",
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
  revokedBy: null,
};

describe("who can open my record", () => {
  it("says so honestly when nobody can", () => {
    grantsRef.value = { given: [], received: [] };
    const html = render(<GrantsGivenCard />);
    expect(html).toContain("Nobody else can open your record");
    expect(html).not.toContain('data-slot="grants-given-list"');
  });

  it("renders the state the server resolved, not one it worked out", () => {
    // Every row carries a `state` the request resolver's own predicate
    // produced. A panel that compared `expiresAt` to the clock would be a
    // second opinion about somebody's access to a health record, and the two
    // would disagree first in the dangerous direction.
    grantsRef.value = {
      given: [
        { ...BASE, id: "a", state: "ACTIVE" },
        { ...BASE, id: "p", state: "PENDING", acceptedAt: null },
        {
          ...BASE,
          id: "e",
          state: "EXPIRED",
          expiresAt: "2026-01-03T00:00:00.000Z",
        },
      ],
      received: [],
    };
    const html = render(<GrantsGivenCard />);
    expect(html).toContain('data-grant-state="ACTIVE"');
    expect(html).toContain('data-grant-state="PENDING"');
    expect(html).toContain('data-grant-state="EXPIRED"');
  });

  it("keeps an ended grant in the list, with who ended it", () => {
    // The row IS the consent record. "Who had access, from when to when, and
    // who ended it" is the question the panel exists to answer, and a list
    // that dropped the ended rows could not answer it.
    grantsRef.value = {
      given: [
        {
          ...BASE,
          state: "REVOKED",
          revokedAt: "2026-02-01T09:00:00.000Z",
          revokedBy: "GRANTOR",
        },
      ],
      received: [],
    };
    const html = render(<GrantsGivenCard />);
    expect(html).toContain('data-grant-state="REVOKED"');
    expect(html).toContain("You ended it");
  });

  it("distinguishes a withdrawal from a handover", () => {
    grantsRef.value = {
      given: [
        {
          ...BASE,
          state: "REVOKED",
          revokedAt: "2026-02-01T09:00:00.000Z",
          revokedBy: "GRANTEE",
        },
      ],
      received: [],
    };
    const html = render(<GrantsGivenCard />);
    // Two facts, one column. A trail that conflated them would misread an
    // ordinary handover as a falling-out.
    expect(html).toContain("Handed back");
    expect(html).not.toContain("You ended it");
  });

  it("offers no way to end a grant that has already ended", () => {
    grantsRef.value = {
      given: [{ ...BASE, state: "REVOKED", revokedAt: "2026-02-01T09:00:00Z" }],
      received: [],
    };
    const ended = render(<GrantsGivenCard />);
    expect(ended).not.toContain('data-slot="grant-revoke"');

    grantsRef.value = { given: [BASE], received: [] };
    const live = render(<GrantsGivenCard />);
    expect(live).toContain('data-slot="grant-revoke"');
  });

  it("says a live grant has never been used rather than leaving a blank", () => {
    grantsRef.value = { given: [{ ...BASE, lastUsedAt: null }], received: [] };
    const html = render(<GrantsGivenCard />);
    expect(html).toContain("never");
  });
});

describe("records I can open", () => {
  it("offers acceptance on an invitation and nothing else", () => {
    grantsRef.value = {
      given: [],
      received: [{ ...BASE, state: "PENDING", acceptedAt: null }],
    };
    const html = render(<GrantsReceivedCard />);
    expect(html).toContain('data-slot="grant-accept"');
    // Nothing to open and nothing to hand back: an invitation confers nothing.
    expect(html).not.toContain('data-slot="grant-open"');
    expect(html).not.toContain('data-slot="grant-renounce"');
  });

  it("offers opening and handing back once it is active", () => {
    grantsRef.value = { given: [], received: [BASE] };
    const html = render(<GrantsReceivedCard />);
    expect(html).toContain('data-slot="grant-open"');
    expect(html).toContain('data-account-id="acct-1"');
    expect(html).toContain('data-slot="grant-renounce"');
    expect(html).not.toContain('data-slot="grant-accept"');
  });
});

describe("when my record was opened", () => {
  it("states its own window, from the number the server resolved", () => {
    // A view that showed "the activity" without saying how far back it can
    // see would imply a completeness it does not have: somebody checking last
    // spring would read an empty list as "no" when the honest answer is
    // "further back than this reaches".
    activityRef.value = { entries: [], retentionDays: 90 };
    const html = render(<RecordActivityCard />);
    expect(html).toContain('data-slot="record-activity-retention"');
    expect(html).toContain("last 90 days");
  });

  it("prints the operator's window, never a compiled-in 365", () => {
    activityRef.value = { entries: [], retentionDays: 30 };
    const html = render(<RecordActivityCard />);
    expect(html).toContain("last 30 days");
    expect(html).not.toContain("365");
  });

  it("says nothing about a window it has not been told", () => {
    // A placeholder here would be exactly the invented value the sentence
    // exists to avoid.
    activityRef.value = undefined;
    const html = render(<RecordActivityCard />);
    expect(html).not.toContain('data-slot="record-activity-retention"');
  });

  it("counts the openings rather than listing them one by one", () => {
    activityRef.value = {
      retentionDays: 365,
      entries: [
        {
          id: "a1",
          actor: { id: "acct-1", username: "housemate", displayName: "Jo" },
          action: "sharing.record.accessed",
          accesses: 40,
          createdAt: "2026-02-03T08:00:00.000Z",
        },
      ],
    };
    const html = render(<RecordActivityCard />);
    expect(html).toContain('data-slot="record-activity-row"');
    expect(html).toContain("Jo");
    expect(html).toContain("40");
  });

  it("names a deleted account as one", () => {
    // The actor column is deliberately not a foreign key, so the id outlives
    // the person. Rendering nothing would read as though the owner had done
    // it themselves.
    activityRef.value = {
      retentionDays: 365,
      entries: [
        {
          id: "a2",
          actor: null,
          action: "sharing.record.accessed",
          accesses: 3,
          createdAt: "2026-02-03T08:00:00.000Z",
        },
      ],
    };
    const html = render(<RecordActivityCard />);
    expect(html).toContain("A deleted account");
  });
});
