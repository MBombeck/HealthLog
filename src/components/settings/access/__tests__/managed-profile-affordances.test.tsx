/**
 * The managed-profile surface, from a static render.
 *
 * ## What an SSR render can prove here, and what it cannot
 *
 * It can prove that a control exists, that the sentence which qualifies it
 * sits beside it in document order, that a list renders one row per profile,
 * and — because the section is composed rather than routed — that the whole
 * card is present for an owner and absent for a delegate. It CANNOT prove that
 * what the form posts reaches the server: there is no click here, so the
 * submit path never runs and every assertion below stays green with the form
 * wired to a constant. That half belongs to `tests/integration/
 * managed-profile-surface.test.ts` (the real routes) and to the browser
 * journey in `e2e/v137-sharing-managed-profiles.spec.ts`.
 *
 * The unit environment is `node`: no jsdom, no testing-library. The pure
 * exports (`displayNameIssue`, `createManagedProfileErrorKey`,
 * `managedProfilesOf`) are where the decisions live, and they are pinned
 * directly for that reason.
 *
 * ## The reachability legs are legs, not reasoning
 *
 * `/settings/access` is an ACTOR surface — grant management is the one thing a
 * delegate must have no reach into — and `access` classifies `personal`, so
 * the prediction is that a Guardian inside a profile and an adult MANAGE
 * delegate both get the refusal panel instead. That is asserted rather than
 * argued: `auth-shell.tsx` and `settings-shell.tsx` decide reachability above
 * every component in this file, and Plan 13 shipped a destination that was
 * admitted and unreachable because the prediction was not checked.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";
import { ApiError } from "@/lib/api/api-fetch";
import type { AccountAccessEntry } from "@/lib/sharing/account-access-view";
import { delegatedDomains } from "@/lib/sharing/domain-write-support";
import type { GrantList } from "@/lib/queries/use-account-grants";
import type { ManagedProfileGuardian } from "@/lib/queries/use-managed-profiles";

/** The account payload, as the cards under test read it. */
const authRef: {
  value: {
    accounts: AccountAccessEntry[];
    active: AccountAccessEntry | null;
  };
} = { value: { accounts: [], active: null } };

vi.mock("@/hooks/use-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-auth")>();
  return {
    ...actual,
    useAuth: () => ({
      user: {
        id: "guardian",
        username: "guardian",
        timezone: "Europe/Berlin",
        accountAccess: {
          accounts: authRef.value.accounts,
          active: authRef.value.active,
          canSwitch: authRef.value.accounts.length > 0,
        },
      },
      isLoading: false,
      isAuthenticated: true,
      isAuthUnknown: false,
      error: null,
      refetch: vi.fn(),
    }),
  };
});

function grantList(partial: Partial<GrantList> = {}): GrantList {
  return { given: [], received: [], retentionDays: 365, ...partial };
}

vi.mock("@/lib/queries/use-account-grants", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/queries/use-account-grants")>();
  return {
    ...actual,
    useAccountGrants: () => ({
      data: grantList(),
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
    useInviteGrant: () => idle(),
    useAcceptGrant: () => idle(),
    useRevokeGrant: () => idle(),
    useRenounceGrant: () => idle(),
  };
});

/**
 * The roster read, as each profile row sees it.
 *
 * Three states, not two. `"loading"` and `"error"` used to share `undefined`,
 * which is precisely the conflation the error branch exists to end: a failed
 * read that renders as a slow one is a person waiting for something that is
 * never coming.
 */
const rosterRef: {
  value: ManagedProfileGuardian[] | "loading" | "error";
} = { value: [] };
/** The deletion mutation, idle unless a case says otherwise. */
const deleteRef = { value: idle() };
/** The guardian invitation, idle unless a case says otherwise. */
const inviteRef: { value: FakeMutation } = { value: idle() };
/** The guardian removal, whose `variables` name a profile and a grant. */
const removeGuardianRef: {
  value: Omit<FakeMutation, "variables"> & {
    variables: { grantId: string } | undefined;
  };
} = { value: { ...idle(), variables: undefined } };

vi.mock("@/lib/queries/use-managed-profiles", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/queries/use-managed-profiles")>();
  return {
    ...actual,
    useCreateManagedProfile: () => idle(),
    useDeleteManagedProfile: () => deleteRef.value,
    useInviteManagedProfileGuardian: () => inviteRef.value,
    useRemoveManagedProfileGuardian: () => removeGuardianRef.value,
    useManagedProfileGuardians: () => ({
      data: Array.isArray(rosterRef.value) ? rosterRef.value : undefined,
      isLoading: rosterRef.value === "loading",
      isError: rosterRef.value === "error",
      refetch: vi.fn(),
    }),
  };
});

vi.mock("@/hooks/use-account-switch", () => ({
  useAccountSwitch: () => ({ mutate: vi.fn(), isPending: false }),
}));

interface FakeMutation {
  mutate: ReturnType<typeof vi.fn>;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  variables: string | undefined;
}

function idle(): FakeMutation {
  return {
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
    variables: undefined,
  };
}

function failed(error: unknown, variables: string): FakeMutation {
  return { ...idle(), isError: true, error, variables };
}

function guardian(
  partial: Partial<ManagedProfileGuardian> = {},
): ManagedProfileGuardian {
  return {
    grantId: "g1",
    account: { id: "acct-1", username: "guardian", displayName: "Alex" },
    state: "ACTIVE",
    invitedAt: "2026-01-02T10:00:00.000Z",
    acceptedAt: "2026-01-02T11:00:00.000Z",
    ...partial,
  };
}

import { AccessSection } from "@/components/settings/access-section";
import { RecordSettingsSectionGate } from "@/components/settings/record-settings-section-gate";
import {
  createManagedProfileErrorKey,
  displayNameIssue,
  FieldGuidance,
} from "../managed-profile-create-form";
import {
  activeGuardianCount,
  deleteProfileBody,
  managedProfilesOf,
} from "../managed-profile-card";
import { guardianInviteErrorKey } from "../managed-profile-guardians";

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

/** The section as the settings page actually mounts it: behind the gate. */
function renderGatedSection(): string {
  return render(
    <RecordSettingsSectionGate section="access">
      <AccessSection />
    </RecordSettingsSectionGate>,
  );
}

function entry(partial: Partial<AccountAccessEntry> = {}): AccountAccessEntry {
  return {
    accountId: "p1",
    username: "managed-abc",
    displayName: "Managed record",
    fullName: null,
    access: "write",
    level: "manage",
    recordKind: "managed",
    sections: null,
    canWrite: true,
    writableDomains: delegatedDomains("manage", null, "write"),
    manageableDomains: delegatedDomains("manage", null, "manage"),
    ...partial,
  };
}

beforeEach(() => {
  authRef.value = { accounts: [], active: null };
  // The caller is always an active Guardian of the profile: it is the only way
  // to have the roster at all.
  rosterRef.value = [guardian({ account: SELF })];
  deleteRef.value = idle();
  inviteRef.value = idle();
  removeGuardianRef.value = { ...idle(), variables: undefined };
});

/** The signed-in account, as the roster names it. */
const SELF = { id: "guardian", username: "guardian", displayName: "You" };

describe("the managed-profile card, in the shared-access section", () => {
  it("renders inside the section, after the invitation card", () => {
    const html = renderGatedSection();
    expect(html).toContain('data-slot="managed-profile-card"');
    // Reading order: the invitation is the first act, this is the second, and
    // the standing state of both follows. A card that drifted below the
    // activity feed would still contain every string this file asserts.
    expect(html.indexOf('data-slot="grant-invite-card"')).toBeLessThan(
      html.indexOf('data-slot="managed-profile-card"'),
    );
    expect(html.indexOf('data-slot="managed-profile-card"')).toBeLessThan(
      html.indexOf('data-slot="grants-given-card"'),
    );
  });

  it("says the record has no login and that the creator looks after it", () => {
    const html = renderGatedSection();
    // The two facts somebody is consenting to. A rewrite that keeps the form
    // and drops either sentence should fail here.
    expect(html).toContain("It has no login and no e-mail address");
    expect(html).toContain("you become its first guardian");
  });

  it("collects the four fields the route accepts and nothing else", () => {
    const html = renderGatedSection();
    for (const slot of [
      "managed-profile-name",
      "managed-profile-dob",
      "managed-profile-locale",
      "managed-profile-create-submit",
    ]) {
      expect(html, slot).toContain(`data-slot="${slot}"`);
    }
    // The timezone control is the shared picker, which labels itself.
    expect(html).toContain('id="managed-profile-timezone"');
    // Six languages offered, which is the route's enum exactly.
    const options =
      /<select[^>]*data-slot="managed-profile-locale"[\s\S]*?<\/select>/
        .exec(html)?.[0]
        .match(/<option/g) ?? [];
    expect(options).toHaveLength(7);
  });

  it("lists the profiles this account looks after, and only those", () => {
    authRef.value = {
      accounts: [
        entry(),
        entry({
          accountId: "a1",
          username: "housemate",
          displayName: "Jo",
          recordKind: "shared",
        }),
      ],
      active: null,
    };
    const html = renderGatedSection();
    expect(html).toContain('data-managed-profile-id="p1"');
    // An adult who shared their own record is not a profile anybody looks
    // after, and offering a delete control for one would be the same mistake
    // one level up.
    expect(html).not.toContain('data-managed-profile-id="a1"');
    expect(html.match(/data-slot="managed-profile-row"/g)).toHaveLength(1);
  });
});

describe("who can reach the section at all", () => {
  it("renders for an unswitched owner", () => {
    const html = renderGatedSection();
    expect(html).toContain('data-slot="managed-profile-card"');
    expect(html).not.toContain("shared-record-settings-unavailable-title");
  });

  it("does not render for a Guardian inside the profile they look after", () => {
    // Grant management is the one surface a delegate must have no reach into,
    // and a Guardian acting AS the profile is a delegate for this purpose.
    authRef.value = { accounts: [entry()], active: entry() };
    const html = renderGatedSection();
    expect(html).toContain("shared-record-settings-unavailable-title");
    expect(html).not.toContain('data-slot="managed-profile-card"');
    expect(html).not.toContain('data-slot="grant-invite-card"');
  });

  it("does not render for an adult delegate holding MANAGE", () => {
    const adult = entry({
      accountId: "a1",
      username: "housemate",
      displayName: "Jo",
      recordKind: "shared",
    });
    authRef.value = { accounts: [adult], active: adult };
    const html = renderGatedSection();
    expect(html).toContain("shared-record-settings-unavailable-title");
    expect(html).not.toContain('data-slot="managed-profile-card"');
  });
});

describe("how a field says what is wrong with it", () => {
  /**
   * The form's invalid states are not reachable from a static render — there
   * is no click, so nothing is ever invalid — which is why the two nodes were
   * pulled out into a pure component. These legs are the whole of the claim
   * the HIGH finding was about: a refusal is content and it is announced.
   */
  it("renders the hint as muted meta and nothing else when the field is fine", () => {
    const html = render(
      <FieldGuidance
        slot="f"
        hintId="f-hint"
        hint="Up to 80 characters."
        error={null}
      />,
    );
    expect(html).toContain('data-slot="f-hint"');
    expect(html).toContain("text-muted-foreground");
    expect(html).not.toContain('data-slot="f-error"');
    expect(html).not.toContain('role="alert"');
  });

  it("announces the refusal, in content contrast, on its own node", () => {
    const html = render(
      <FieldGuidance
        slot="f"
        hintId="f-hint"
        hint="Up to 80 characters."
        error="That name is longer than 80 characters."
      />,
    );
    const alert = /<p[^>]*data-slot="f-error"[^>]*>/.exec(html)?.[0];
    expect(alert).toBeDefined();
    // Announced, because it MOUNTS with the role rather than a class being
    // swapped onto a node that was already there.
    expect(alert).toContain('role="alert"');
    // Content, not meta. UI-STANDARDS §3, and the same reasoning
    // `grant-action-error.tsx` spells out: a refusal rendered as muted is a
    // refusal nobody reads.
    expect(alert).toContain("text-destructive");
    expect(alert).not.toContain("text-muted-foreground");
    // And the hint survives beside it rather than being overwritten, so the
    // bound the person is being held to is still on screen.
    expect(html).toContain('data-slot="f-hint"');
    expect(html).toContain("Up to 80 characters.");
  });

  it("renders the error alone for a control that brings its own hint", () => {
    // The timezone picker labels itself; the form owes only the refusal, and
    // that refusal is the only explanation for a submit button that will not
    // press.
    const html = render(
      <FieldGuidance slot="tz" error="This browser does not know that zone." />,
    );
    expect(html).toContain('data-slot="tz-error"');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('data-slot="tz-hint"');
  });

  it("keeps the standing hint muted on the rendered form", () => {
    // The other half, on the real component: the default state is guidance,
    // and guidance IS meta.
    authRef.value = { accounts: [], active: null };
    const html = renderGatedSection();
    const hint = /<p[^>]*data-slot="managed-profile-name-hint"[^>]*>/.exec(
      html,
    )?.[0];
    expect(hint).toBeDefined();
    expect(hint).toContain("text-muted-foreground");
    expect(html).not.toContain('data-slot="managed-profile-name-error"');
    expect(html).not.toContain('data-slot="managed-profile-timezone-error"');
  });
});

describe("what the form decides before it sends", () => {
  it("treats a whitespace-only name as empty, because the route does", () => {
    // The route trims and then requires 1..80. A client that did not trim
    // would offer to send a name the server reads as absent.
    expect(displayNameIssue("   ")).toBe("recordSharing.managed.nameRequired");
    expect(displayNameIssue("")).toBe("recordSharing.managed.nameRequired");
    expect(displayNameIssue("  Managed record  ")).toBeNull();
  });

  it("holds the route's own 80-character bound", () => {
    expect(displayNameIssue("x".repeat(80))).toBeNull();
    expect(displayNameIssue("x".repeat(81))).toBe(
      "recordSharing.managed.nameTooLong",
    );
    // And trailing space does not push a valid name over the edge.
    expect(displayNameIssue(`${"x".repeat(80)}   `)).toBeNull();
  });

  it("routes the step-up gate to its own sentence, not to a failure", () => {
    // Every route in this family resolves `requireFreshMfa`, so for anybody
    // with a second factor this is the FIRST answer, not an error. Told as a
    // failure it sends somebody looking for a problem with what they typed.
    expect(
      createManagedProfileErrorKey(
        new ApiError("refused", 401, { errorCode: "auth.stepup.required" }),
      ),
    ).toBe("recordSharing.managed.errorStepUp");
    expect(createManagedProfileErrorKey(new ApiError("refused", 422))).toBe(
      "recordSharing.managed.errorInvalid",
    );
    expect(createManagedProfileErrorKey(new ApiError("refused", 500))).toBe(
      "recordSharing.managed.errorFailed",
    );
    // Not an `ApiError` means no response came back at all.
    expect(createManagedProfileErrorKey(new TypeError("Failed to fetch"))).toBe(
      "recordSharing.managed.errorOffline",
    );
    // The four are distinct, so a resolver returning one key for everything
    // fails here rather than passing each row above by accident.
    expect(
      new Set(
        [401, 422, 500].map((s) =>
          createManagedProfileErrorKey(new ApiError("refused", s)),
        ),
      ).size,
    ).toBe(3);
  });

  it("keeps a refused creation's fields, and clears them only on success", () => {
    // A static render cannot press the button, so the claim is made about the
    // code path: every reset lives inside `onSuccess`. A reset that migrated
    // into `onError` would wipe a typed name on a failure the person is being
    // asked to retry.
    const source = readForm();
    const start = source.indexOf("onSuccess:");
    const split = source.indexOf("onError:", start);
    expect(start).toBeGreaterThan(-1);
    expect(split).toBeGreaterThan(start);
    const onSuccess = source.slice(start, split);
    const onError = source.slice(split);
    expect(onSuccess).toContain("setCreated");
    expect(onError).toContain("createManagedProfileErrorKey");
    for (const reset of [
      'setDisplayName("")',
      'setDateOfBirth("")',
      "setLocale(actorLocale)",
      "setTimezone(browserTimezone())",
    ]) {
      expect(onSuccess, reset).toContain(reset);
      expect(onError, reset).not.toContain(reset);
    }
  });
});

describe("ending a managed profile", () => {
  it("offers a confirmed delete on the profile's own row", () => {
    authRef.value = { accounts: [entry()], active: null };
    const html = renderGatedSection();
    expect(html).toContain('data-slot="managed-profile-delete"');
    // The mobile tap floor UI-STANDARDS §11 asks of an inline action.
    expect(html).toMatch(
      /data-slot="managed-profile-delete"[^>]*class="[^"]*min-h-11/,
    );
  });

  it("withholds the control until the roster has answered", () => {
    // The confirm copy states how many people lose the record, and that number
    // comes from the roster. A control that existed before the read would put
    // the sentence's presence at the mercy of which request landed first —
    // the defect the retention disclosure already paid for once.
    authRef.value = { accounts: [entry()], active: null };
    rosterRef.value = "loading";
    const html = renderGatedSection();
    expect(html).toContain('data-managed-profile-id="p1"');
    expect(html).not.toContain('data-slot="managed-profile-delete"');
  });

  it("announces a refused deletion on the row it was refused for", () => {
    authRef.value = {
      accounts: [entry(), entry({ accountId: "p2", displayName: "Second" })],
      active: null,
    };
    deleteRef.value = failed(
      new ApiError("refused", 404, {
        errorCode: "managed_profile.not_found",
      }),
      "p1",
    );
    const html = renderGatedSection();

    expect(html).toContain('data-slot="grant-action-error"');
    expect(html).toContain('data-grant-error-for="p1"');
    // Not painted onto the profile that did not fail.
    expect(html).not.toContain('data-grant-error-for="p2"');
    expect(html.match(/data-slot="grant-action-error"/g)).toHaveLength(1);
    // Specific, not the generic "could not be deleted".
    expect(html).toContain("That profile is not there any more");
    // Retryable, and the row keeps its control.
    expect(html).toContain('data-slot="grant-action-retry"');
    expect(html).toContain('data-slot="managed-profile-delete"');
  });

  it("shows nothing at all while the deletion is idle", () => {
    authRef.value = { accounts: [entry()], active: null };
    expect(renderGatedSection()).not.toContain(
      'data-slot="grant-action-error"',
    );
  });

  it("names the step-up gate rather than reporting a failure", () => {
    // The likeliest refusal of all, and the one that read as a defect. Both
    // destructive acts sit behind a `ConfirmButton`, so the request that
    // reaches the server is the second click — minutes after the panel was
    // opened, and easily outside the five-minute window.
    authRef.value = { accounts: [entry()], active: null };
    deleteRef.value = failed(
      new ApiError("refused", 401, { errorCode: "auth.stepup.required" }),
      "p1",
    );
    const html = renderGatedSection();
    expect(html).toContain("Confirm your second factor");
    expect(html).not.toContain("The profile could not be deleted");
  });

  it("tells a guardian with no second factor where to get one", () => {
    // `requireFreshMfa` refuses an unenrolled account with its own code, and
    // "confirm your second factor" to somebody who has none is a dead end
    // offered by the surface that owns the way out of it.
    authRef.value = { accounts: [entry()], active: null };
    deleteRef.value = failed(
      new ApiError("refused", 401, {
        errorCode: "auth.stepup.mfa_not_enrolled",
      }),
      "p1",
    );
    const html = renderGatedSection();
    expect(html).toContain("does not have one yet");
    expect(html).toContain("Security");
  });

  it("says a failed roster read failed, rather than looking like a slow one", () => {
    // Without this branch a 500 renders exactly as a still-loading roster —
    // no panel, no delete control — and the person waits for something that is
    // never coming.
    authRef.value = { accounts: [entry()], active: null };
    rosterRef.value = "error";
    const html = renderGatedSection();
    expect(html).toContain('data-slot="query-error-card"');
    expect(html).toContain("Could not load who looks after this record");
    // And the way back is reachable, which is what UI-STANDARDS §6 asks of an
    // error state.
    expect(html).toContain('data-slot="query-error-retry"');
  });
});

describe("what the confirmation says before it deletes", () => {
  const t = (key: string, params?: Record<string, string | number>): string =>
    params ? `${key}(${JSON.stringify(params)})` : key;
  const tCount = (
    base: string,
    count: number,
    params?: Record<string, string | number>,
  ): string => `${base}:${count}(${JSON.stringify(params)})`;

  it("names what goes, how many people lose it, and the way out", () => {
    const body = deleteProfileBody({
      t,
      tCount,
      name: "Managed record",
      activeGuardians: 2,
    });
    expect(body).toContain(
      'recordSharing.managed.deleteBody({"name":"Managed record"})',
    );
    expect(body).toContain("recordSharing.managed.deleteGuardians:2");
    // The delete route emits no last-Guardian refusal, because deleting IS the
    // way out of the floor. The copy says so rather than duplicating a refusal
    // this route never sends.
    expect(body).toContain("recordSharing.managed.deleteFloorNote");
  });

  it("counts the guardians who actually hold the record", () => {
    // A pending invitation confers nothing, and the server counts the same
    // way. Counting it would tell somebody two people lose the record when
    // one does.
    expect(
      activeGuardianCount([
        guardian(),
        guardian({ grantId: "g2", state: "PENDING", acceptedAt: null }),
      ]),
    ).toBe(1);
    expect(activeGuardianCount([])).toBe(0);
    expect(activeGuardianCount(undefined)).toBe(0);
  });
});

describe("managing the guardians of a profile", () => {
  const OTHER = { id: "other", username: "housemate", displayName: "Jo" };

  beforeEach(() => {
    authRef.value = { accounts: [entry()], active: null };
  });

  it("renders one row per guardian and says which of them is you", () => {
    rosterRef.value = [
      guardian({ account: SELF }),
      guardian({ grantId: "g2", account: OTHER }),
    ];
    const html = renderGatedSection();
    expect(html.match(/data-slot="managed-profile-guardian"/g)).toHaveLength(2);
    expect(html).toContain('data-guardian-grant-id="g2"');
    expect(html).toContain("(you)");
  });

  it("states the floor before the act when nobody else has accepted", () => {
    // The whole point of the roster read. Discovering this as a 409 after
    // inviting somebody is the state the release goal asks us to end.
    rosterRef.value = [
      guardian({ account: SELF }),
      guardian({
        grantId: "g2",
        account: OTHER,
        state: "PENDING",
        acceptedAt: null,
      }),
    ];
    const html = renderGatedSection();
    expect(html).toContain('data-slot="managed-profile-sole-guardian"');
    expect(html).toContain("only person looking after");
    // And it names all three ways forward rather than only refusing.
    expect(html).toContain("wait for them to accept");
    expect(html).toContain("Records I can open");
    expect(html).toContain("delete the profile");
  });

  it("stops stating the floor once a second guardian has accepted", () => {
    rosterRef.value = [
      guardian({ account: SELF }),
      guardian({ grantId: "g2", account: OTHER }),
    ];
    expect(renderGatedSection()).not.toContain(
      'data-slot="managed-profile-sole-guardian"',
    );
  });

  it("offers no control to end one's own access, and says where that lives", () => {
    // `revokeManagedProfileGuardian` refuses a target grant whose grantee is
    // the caller, and the route answers the same 404 an unknown profile gets.
    // A self-removal button would be one that always fails.
    rosterRef.value = [guardian({ account: SELF })];
    const html = renderGatedSection();
    expect(html).not.toContain('data-slot="managed-profile-guardian-remove"');
    expect(html).toContain('data-slot="managed-profile-sole-guardian"');
  });

  it("offers a confirmed removal on another guardian's row", () => {
    rosterRef.value = [
      guardian({ account: SELF }),
      guardian({ grantId: "g2", account: OTHER }),
    ];
    const html = renderGatedSection();
    expect(
      html.match(/data-slot="managed-profile-guardian-remove"/g),
    ).toHaveLength(1);
    expect(html).toMatch(
      /data-slot="managed-profile-guardian-remove"[^>]*class="[^"]*min-h-11/,
    );
  });

  it("offers to withdraw an invitation that has not been accepted", () => {
    // A pending invitation confers nothing, so withdrawing it can never
    // strand the record and the control is not withheld.
    rosterRef.value = [
      guardian({ account: SELF }),
      guardian({
        grantId: "g2",
        account: OTHER,
        state: "PENDING",
        acceptedAt: null,
      }),
    ];
    const html = renderGatedSection();
    expect(
      html.match(/data-slot="managed-profile-guardian-remove"/g),
    ).toHaveLength(1);
  });

  it("says an invitation only counts once it is accepted", () => {
    const html = renderGatedSection();
    expect(html).toContain('data-slot="managed-profile-pending-note"');
    expect(html).toContain("counts only once they accept");
    // In document order the sentence sits ahead of the control it qualifies.
    expect(
      html.indexOf('data-slot="managed-profile-pending-note"'),
    ).toBeLessThan(html.indexOf('data-slot="managed-profile-guardian-submit"'));
  });

  it("announces a refused removal on the guardian row it belongs to", () => {
    rosterRef.value = [
      guardian({ account: SELF }),
      guardian({ grantId: "g2", account: OTHER }),
      guardian({ grantId: "g3", account: { ...OTHER, id: "third" } }),
    ];
    removeGuardianRef.value = {
      ...idle(),
      isError: true,
      error: new ApiError("refused", 409, {
        errorCode: "managed_profile.guardian.required",
      }),
      variables: { grantId: "g2" },
    };
    const html = renderGatedSection();
    expect(html).toContain('data-grant-error-for="g2"');
    expect(html).not.toContain('data-grant-error-for="g3"');
    // The floor, still handled as a refusal even though the panel states it
    // in advance: the roster can be stale by the time the click lands.
    expect(html).toContain("Add another guardian first");
  });

  it("announces a refused invitation on the form, without clearing it", () => {
    inviteRef.value = failed(
      new ApiError("refused", 409, {
        errorCode: "managed_profile.guardian.duplicate",
      }),
      "ignored",
    );
    const html = renderGatedSection();
    expect(html).toContain('data-slot="managed-profile-guardian-error"');
    expect(html).toContain("already has access to this record");
    expect(html).toContain('data-slot="managed-profile-guardian-identifier"');
  });
});

describe("what a refused guardian invitation says", () => {
  const cases: Array<{ err: unknown; key: string; why: string }> = [
    {
      err: new ApiError("refused", 409, {
        errorCode: "managed_profile.guardian.duplicate",
      }),
      key: "recordSharing.managed.guardianErrorDuplicate",
      why: "that account already has access — which is also what inviting yourself answers, because the grantor is the profile and never the caller",
    },
    {
      err: new ApiError("refused", 422, {
        errorCode: "managed_profile.guardian.managed_invitee",
      }),
      key: "recordSharing.managed.guardianErrorManagedInvitee",
      why: "a managed profile cannot look after another record",
    },
    {
      err: new ApiError("refused", 404, {
        errorCode: "managed_profile.not_found",
      }),
      key: "recordSharing.actionError.profileNotFound",
      why: "a 404 WITH a code — not the same as an unknown identifier",
    },
    {
      err: new ApiError("refused", 404),
      key: "recordSharing.managed.guardianErrorNoAccount",
      why: "the codeless 404: no account carries that name or e-mail",
    },
    {
      err: new ApiError("refused", 429),
      key: "recordSharing.managed.guardianErrorRateLimit",
      why: "the other codeless arm, where waiting is the whole recovery",
    },
    {
      err: new ApiError("refused", 401, {
        errorCode: "auth.stepup.required",
      }),
      key: "recordSharing.managed.errorStepUp",
      why: "the step-up gate every route in this family carries",
    },
    {
      err: new ApiError("refused", 500),
      key: "recordSharing.managed.guardianErrorFailed",
      why: "an unclassified failure still says which act failed",
    },
    {
      err: new TypeError("Failed to fetch"),
      key: "recordSharing.managed.errorOffline",
      why: "never reached the server, so nothing was invited",
    },
  ];

  for (const { err, key, why } of cases) {
    it(why, () => {
      expect(guardianInviteErrorKey(err)).toBe(key);
    });
  }

  it("tells the two 404s apart, which is the whole reason for the order", () => {
    // The route publishes a code on one 404 and not on the other. Branching on
    // status first would tell somebody to check a spelling when the real
    // answer is that they are no longer a Guardian of that profile.
    expect(
      guardianInviteErrorKey(
        new ApiError("refused", 404, {
          errorCode: "managed_profile.not_found",
        }),
      ),
    ).not.toBe(guardianInviteErrorKey(new ApiError("refused", 404)));
    // And all nine cases above resolve to distinct sentences rather than one:
    // the failure this table is written against is one message for everything.
    expect(
      new Set(cases.map(({ err }) => guardianInviteErrorKey(err))).size,
    ).toBe(cases.length);
  });
});

describe("which accounts count as profiles looked after", () => {
  it("keeps the managed entries and drops the rest", () => {
    const managed = entry();
    const shared = entry({ accountId: "a1", recordKind: "shared" });
    expect(managedProfilesOf([managed, shared])).toEqual([managed]);
    expect(managedProfilesOf(undefined)).toEqual([]);
  });
});

function readForm(): string {
  return readFileSync(
    join(
      process.cwd(),
      "src/components/settings/access/managed-profile-create-form.tsx",
    ),
    "utf8",
  );
}
