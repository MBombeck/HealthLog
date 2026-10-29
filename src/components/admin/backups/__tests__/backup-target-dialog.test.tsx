/**
 * The choice offered when an uploaded file's account is not on this server.
 *
 * SSR markup per project convention, plus the pure rules the dialog submits
 * by: a new account needs a valid, free username; an existing one needs the
 * server's yes for exactly that account and its username typed; managed
 * profiles and accounts pending deletion are never offered; and each refusal
 * the upload can answer has its own sentence.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AdminUser } from "@/components/admin/_shared";
import { ApiError } from "@/lib/api/api-fetch";
import { I18nProvider } from "@/lib/i18n/context";

import {
  BackupTargetForm,
  EMPTY_TARGET_DRAFT,
  pickableAccounts,
  readyTarget,
  targetUploadFailureKey,
  type BackupTargetCheck,
  type BackupTargetDraft,
} from "../backup-target-dialog";

function user(overrides: Partial<AdminUser>): AdminUser {
  return {
    id: "u1",
    username: "returning-person",
    email: null,
    role: "USER",
    createdAt: "2026-10-01T00:00:00.000Z",
    mfaEnforced: false,
    documentQuotaBytes: null,
    passkeyCount: 0,
    managedProfile: false,
    deletion: null,
    ...overrides,
  };
}

const USERS = [
  user({ id: "u1", username: "returning-person", email: "r@example.test" }),
  user({ id: "u2", username: "managed-cafe01", managedProfile: true }),
  user({
    id: "u3",
    username: "leaving",
    deletion: { requestedAt: "x", purgeAt: null, requestedBy: "self" },
  }),
  user({ id: "u4", username: "operator", role: "ADMIN" }),
];

const ELIGIBLE: BackupTargetCheck = {
  id: "u1",
  username: "returning-person",
  eligible: true,
  reason: null,
  models: [],
};

function render(
  draft: BackupTargetDraft,
  check: { data?: BackupTargetCheck; loading: boolean; error: unknown } = {
    loading: false,
    error: null,
  },
): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <BackupTargetForm
        draft={draft}
        onChange={() => {}}
        disabled={false}
        users={USERS}
        check={check}
      />
    </I18nProvider>,
  );
}

describe("pickableAccounts", () => {
  it("offers neither managed profiles, accounts pending deletion nor admin accounts", () => {
    expect(pickableAccounts(USERS).map((u) => u.username)).toEqual([
      "returning-person",
    ]);
  });
});

describe("readyTarget", () => {
  it("takes a new account with a valid username nobody has", () => {
    expect(
      readyTarget(
        { ...EMPTY_TARGET_DRAFT, username: " back-again " },
        USERS,
        undefined,
      ),
    ).toEqual({ into: "new", username: "back-again" });
  });

  it("refuses a new username that is taken, malformed or reads as a managed profile", () => {
    for (const username of ["operator", "no spaces", "ab", "managed-x1"]) {
      expect(
        readyTarget({ ...EMPTY_TARGET_DRAFT, username }, USERS, undefined),
        username,
      ).toBeNull();
    }
  });

  it("takes an existing account only with the server's yes and its username typed", () => {
    const draft: BackupTargetDraft = {
      into: "existing",
      username: "",
      userId: "u1",
      confirm: "returning-person",
    };
    expect(readyTarget(draft, USERS, ELIGIBLE)).toEqual({
      into: "existing",
      userId: "u1",
      confirm: "returning-person",
    });
    expect(readyTarget(draft, USERS, undefined)).toBeNull();
    expect(
      readyTarget(draft, USERS, {
        ...ELIGIBLE,
        eligible: false,
        reason: "holds_records",
        models: ["Measurement"],
      }),
    ).toBeNull();
    // A yes for another account does not carry over.
    expect(readyTarget(draft, USERS, { ...ELIGIBLE, id: "u4" })).toBeNull();
    expect(
      readyTarget({ ...draft, confirm: "Returning-Person" }, USERS, ELIGIBLE),
    ).toBeNull();
  });
});

describe("targetUploadFailureKey", () => {
  it("names each refusal the upload answers with, and falls back for the rest", () => {
    const key = (errorCode?: string) =>
      targetUploadFailureKey(
        new ApiError("x", 409, errorCode ? { errorCode } : undefined),
      );
    expect(key("backup.target.holds_records")).toBe(
      "admin.section.backups.target.failureHoldsRecords",
    );
    expect(key("backup.target.managed_profile")).toBe(
      "admin.section.backups.target.failureManagedProfile",
    );
    expect(key("backup.target.pending_deletion")).toBe(
      "admin.section.backups.target.failurePendingDeletion",
    );
    expect(key("backup.target.admin_account")).toBe(
      "admin.section.backups.target.failureAdminAccount",
    );
    expect(key("backup.target.not_found")).toBe(
      "admin.section.backups.target.failureNotFound",
    );
    expect(key("backup.target.unconfirmed")).toBe(
      "admin.section.backups.target.failureUnconfirmed",
    );
    expect(key("backup.target.username_taken")).toBe(
      "admin.section.backups.target.failureUsernameTaken",
    );
    expect(key("backup.owner.exists")).toBe(
      "admin.section.backups.target.failureOwnerExists",
    );
    expect(key()).toBe("admin.section.backups.uploadFailed");
    expect(targetUploadFailureKey(new Error("offline"))).toBe(
      "admin.section.backups.uploadFailed",
    );
  });
});

describe("<BackupTargetForm>", () => {
  it("starts on a new account, with the sign-in note", () => {
    const html = render(EMPTY_TARGET_DRAFT);
    expect(html).toContain('data-testid="backup-target-username"');
    expect(html).toContain("created without a password or email");
    expect(html).not.toContain('data-testid="backup-target-account"');
  });

  it("says a taken username is taken", () => {
    const html = render({ ...EMPTY_TARGET_DRAFT, username: "operator" });
    expect(html).toContain("This username is already taken.");
  });

  it("offers only pickable accounts, and asks for the username once the server says yes", () => {
    const html = render(
      { into: "existing", username: "", userId: "u1", confirm: "" },
      { data: ELIGIBLE, loading: false, error: null },
    );
    expect(html).toContain("returning-person (r@example.test)");
    expect(html).not.toContain(">operator<");
    expect(html).not.toContain("managed-cafe01");
    expect(html).not.toContain(">leaving<");
    expect(html).toContain('data-slot="backup-target-eligible"');
    expect(html).toContain("Type returning-person to confirm");
    expect(html).toContain('data-testid="backup-target-confirm"');
  });

  it("says why an account that holds records cannot take the copy, and asks nothing more", () => {
    const html = render(
      { into: "existing", username: "", userId: "u1", confirm: "" },
      {
        data: {
          ...ELIGIBLE,
          eligible: false,
          reason: "holds_records",
          models: ["Measurement"],
        },
        loading: false,
        error: null,
      },
    );
    expect(html).toContain('data-slot="backup-target-refused"');
    expect(html).toContain("This account already holds records.");
    expect(html).not.toContain('data-testid="backup-target-confirm"');
  });
});
