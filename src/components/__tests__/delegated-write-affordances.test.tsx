/**
 * What a delegate is offered, rendered rather than described.
 *
 * v1.36.0 shipped sharing read-only and gated it only in the application
 * chrome. Every feature surface still painted its add button, and a delegate
 * who tapped one met a 403 from a server that was right to refuse. These
 * render the real controls to markup and assert the paint, on the three
 * capability states a session can be in.
 *
 * The suite is SSR-only (`@testing-library/react` is not a dependency here),
 * which bounds what it can prove: it holds the RENDER, never the click. A
 * control that is absent here cannot be tapped, and that is the whole property
 * — but a control that is present here is not proven to work, and a submit
 * path is not proven at all. That leg lives in `e2e/account-sharing.spec.ts`.
 *
 * Mutation checks, run:
 *   - `useRecordCapabilities` returning `canAdd: true` unconditionally → the
 *     read-only legs for the intake row and the card menu go red.
 *   - `DeleteButton` dropping its `canManageDomain` bail → "no row delete inside
 *     somebody else's record" goes red; answering it for every section → the
 *     vault leg of "a guardian's row delete follows the section" goes red.
 *   - `TodayHero` passing `onDismiss` / `onAction` unconditionally → the rail
 *     legs go red, printing the dismiss control and the check-in buttons.
 *   - `VorsorgeDashboardCard` dropping its `canManageDomain` bail → the
 *     mark-done leg goes red.
 *   - `EpisodeDocumentsCard` dropping its `canManageDomain` bail → the link +
 *     upload leg goes red, on the MANAGE arm.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import type {
  AccountAccess,
  AccountAccessEntry,
} from "@/lib/sharing/account-access-view";
import { delegatedDomains } from "@/lib/sharing/domain-write-support";
import type { ShareDomain } from "@/lib/sharing/scope";

const OWNER = {
  accountId: "acct-owner",
  username: "owner",
  displayName: "Margarethe",
  fullName: null,
  access: "read" as const,
  level: "read" as const,
  sections: null,
  recordKind: "shared" as const,
  canWrite: false,
  writableDomains: [],
  manageableDomains: [],
};

const OWN_RECORD: AccountAccess = {
  accounts: [OWNER],
  active: null,
  canSwitch: true,
};
const READ_ONLY: AccountAccess = {
  accounts: [OWNER],
  active: OWNER,
  canSwitch: true,
};
const WRITABLE: AccountAccess = {
  accounts: [OWNER],
  active: {
    ...OWNER,
    access: "write",
    level: "write",
    canWrite: true,
    writableDomains: delegatedDomains("write", null, "write"),
    manageableDomains: [],
  },
  canSwitch: true,
};
/**
 * v1.38.12 — a MANAGE grant, published as the server publishes it: the
 * sections with a delegated route, and never the vault.
 */
const MANAGING: AccountAccess = {
  accounts: [OWNER],
  active: {
    ...OWNER,
    access: "write",
    level: "manage",
    canWrite: true,
    writableDomains: delegatedDomains("manage", null, "write"),
    manageableDomains: delegatedDomains("manage", null, "manage"),
  },
  canSwitch: true,
};

/**
 * A grant with a SCOPE, published the way the server publishes one.
 *
 * Every fixture above carries `sections: null`, and that is the hole the
 * section-blind controls lived in: a WRITE grant scoped to one section answers
 * `canWrite: true` like any other, so a control asking the coarse question was
 * offered in sections the grant never opened. The two lists are the level ×
 * scope × route-table intersection, derived here by the same function the
 * server derives them with rather than by hand.
 */
function grant(
  level: AccountAccessEntry["level"],
  sections: ShareDomain[] | null,
): AccountAccess {
  return {
    accounts: [OWNER],
    active: {
      ...OWNER,
      access: level === "read" ? "read" : "write",
      level,
      sections,
      canWrite: level !== "read",
      writableDomains: delegatedDomains(level, sections, "write"),
      manageableDomains: delegatedDomains(level, sections, "manage"),
    },
    canSwitch: true,
  };
}

const mockAccessRef: { value: AccountAccess } = { value: OWN_RECORD };

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "delegate",
      username: "delegate",
      email: null,
      role: "USER",
      avatarUrl: null,
      // The episode-documents card renders only for an account with the
      // vault switched on; every other surface here ignores the map.
      modules: { inboundDocuments: true },
      accountAccess: mockAccessRef.value,
    },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

// The Vorsorge summary pushes to the check-in page for a screening reminder.
// Nothing below clicks, so a stub router is enough to let it mount.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

// Never resolves inside the synchronous render, so every query below stays
// pending and each component paints its own loading branch. The controls this
// file is about live outside that branch.
vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: () => new Promise(() => {}),
  apiPost: () => new Promise(() => {}),
  apiPut: () => new Promise(() => {}),
  apiPatch: () => new Promise(() => {}),
  apiDelete: () => new Promise(() => {}),
}));

import { DeleteButton } from "@/components/data-list/delete-button";
import { SelectionActionBar } from "@/components/data-list/selection-action-bar";
import { MedicationCardMenu } from "@/components/medications/medication-card-menu";
import { MedicationIntakeActions } from "@/components/medications/card-parts/medication-intake-actions";
import {
  admittedCaptureKind,
  visibleCaptureKinds,
} from "@/components/layout/capture-picker";
import { admittedQuickEntry } from "@/components/dashboard/quick-entry-sheets";
import { TodayHero } from "@/components/daily/today-hero";
import { VorsorgeDashboardCard } from "@/components/measurement-reminders/vorsorge-dashboard-card";
import { EpisodeDocumentsCard } from "@/components/documents/episode-documents-card";
import { LedgerRowItem } from "@/components/medications/dose-history-ledger";
import { VaccinationsView } from "@/components/vaccinations/vaccinations-view";
import { queryKeys } from "@/lib/query-keys";
import type { DailyDigest } from "@/lib/daily/digest";
import type { MeasurementReminder } from "@/hooks/use-measurement-reminders";

function render(
  access: AccountAccess,
  node: React.ReactNode,
  /**
   * Seed the cache a query-backed component reads, so it paints its populated
   * branch inside a synchronous render instead of its skeleton. Cheaper and
   * truer than mocking the hook: the component under test is the real one.
   */
  seed?: (client: QueryClient) => void,
): string {
  mockAccessRef.value = access;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  seed?.(queryClient);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("row delete", () => {
  const node = (
    <DeleteButton
      domain="labs"
      onConfirm={() => {}}
      title="Delete?"
      description="Gone."
    />
  );

  it("renders in the caller's own record", () => {
    expect(render(OWN_RECORD, node)).toContain("<button");
  });

  it("is absent inside somebody else's record below MANAGE", () => {
    // Not disabled. A greyed bin still claims the row is the delegate's to
    // remove, and it is not — at either grant level, including for a row the
    // delegate entered themselves.
    expect(render(READ_ONLY, node)).toBe("");
    expect(render(WRITABLE, node)).toBe("");
  });

  it("follows the section for a guardian: labs yes, the vault and owner-only rows no", () => {
    // The v1.37.0 hold-back answered "no" for every section; #939 is what
    // that cost. The answer is per section now, and the server's.
    expect(render(MANAGING, node)).toContain("<button");
    expect(
      render(
        MANAGING,
        <DeleteButton
          domain="documents"
          onConfirm={() => {}}
          title="Delete?"
          description="Gone."
        />,
      ),
    ).toBe("");
    // `null`: the row's delete route resolves the caller (custom metrics).
    expect(
      render(
        MANAGING,
        <DeleteButton
          domain={null}
          onConfirm={() => {}}
          title="Delete?"
          description="Gone."
        />,
      ),
    ).toBe("");
  });
});

describe("bulk selection bar", () => {
  const node = (
    <SelectionActionBar
      domain="mind"
      count={3}
      onClear={() => {}}
      onConfirmDelete={() => {}}
      isDeleting={false}
      confirmTitle="Delete 3?"
      confirmBody="Gone."
    />
  );

  it("renders in the caller's own record", () => {
    expect(render(OWN_RECORD, node)).toContain(
      'data-slot="selection-action-bar"',
    );
  });

  it("is absent inside somebody else's record below MANAGE", () => {
    expect(render(WRITABLE, node)).toBe("");
  });

  it("renders for a guardian in a section whose bulk route answers", () => {
    expect(render(MANAGING, node)).toContain(
      'data-slot="selection-action-bar"',
    );
  });
});

describe("marking a dose", () => {
  const node = (
    <MedicationIntakeActions intakeLoading={null} onRecordIntake={() => {}} />
  );

  it("is offered to a delegate who may write", () => {
    // The verb the delegation was written for: somebody looking after a
    // parent marks the morning dose taken.
    expect(render(WRITABLE, node)).toContain("<button");
  });

  it("is absent for a read-only delegate", () => {
    expect(render(READ_ONLY, node)).toBe("");
  });

  it("is offered in the caller's own record", () => {
    expect(render(OWN_RECORD, node)).toContain("<button");
  });
});

describe("the medication card menu", () => {
  const node = (
    <MedicationCardMenu
      onEdit={() => {}}
      onOpenHistory={() => {}}
      onLogSideEffect={() => {}}
    />
  );

  it("renders its trigger in the caller's own record", () => {
    expect(render(OWN_RECORD, node)).toContain("<button");
  });

  it("keeps a trigger for a delegate who may write", () => {
    // One item survives for them — noting a side effect — so the menu stays.
    expect(render(WRITABLE, node)).toContain("<button");
  });

  it("disappears entirely for a read-only delegate", () => {
    // Every item in it is owner work, so the trigger goes with them rather
    // than opening onto an empty sheet.
    expect(render(READ_ONLY, node)).toBe("");
  });
});

/* -------------------------------------------------------------------------- */
/* The Today rail                                                             */
/* -------------------------------------------------------------------------- */

const DIGEST: DailyDigest = {
  generatedAt: "2026-08-03T06:00:00.000Z",
  phase: "final",
  sleepPending: false,
  score: null,
  topSignal: null,
  briefingLead: "A steady week so far.",
  line: "A steady week so far.",
  justIn: null,
  reactionLine: null,
  worthALook: [
    {
      kind: "milestone",
      itemKey: "milestone:steps-10k",
      title: "Ten thousand steps",
      actions: [],
    },
    {
      kind: "coach_checkin",
      title: "Still worth keeping?",
      actions: [
        {
          labelKey: "daily.action.checkinKeep",
          intent: "coach.plan.keep:plan-1",
        },
        {
          labelKey: "daily.action.viewCheckups",
          intent: "checkup.view",
          href: "/checkups",
        },
      ],
    },
  ],
};

describe("the Today rail's mutating affordances", () => {
  const node = <TodayHero digest={DIGEST} />;

  it("offers the dismiss and the check-in answer in the caller's own record", () => {
    const html = render(OWN_RECORD, node);
    expect(html).toContain('data-slot="priority-card-dismiss"');
    expect(html).toContain("Keep it");
  });

  it("withholds both inside somebody else's record, at every level", () => {
    // Dismissing an observation and answering a coach check-in are neither of
    // them an admitted create, and both write through routes that resolve the
    // CALLER — so a delegate tapping either would file it against their own
    // record if the route allowed it, and gets a 403 because it does not. A
    // MANAGE grant changes nothing here: no section reaches a caller route.
    for (const access of [READ_ONLY, WRITABLE, MANAGING]) {
      const html = render(access, node);
      expect(html).not.toContain('data-slot="priority-card-dismiss"');
      expect(html).not.toContain("Keep it");
      // The rail itself stays: reading what is worth a look is the point of
      // opening somebody's record, and the navigation action survives with it.
      expect(html).toContain('data-slot="today-hero-rail"');
      expect(html).toContain('href="/checkups"');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Vorsorge                                                                   */
/* -------------------------------------------------------------------------- */

const REMINDER: MeasurementReminder = {
  id: "rem-1",
  label: "Dental check-up",
  measurementType: null,
  intervalDays: 180,
  rrule: null,
  anchorDate: null,
  endsOn: null,
  origin: "VORSORGE",
  notifyHour: 9,
  location: null,
  nextDueAt: "2026-08-10T09:00:00.000Z",
  lastSatisfiedAt: null,
  snoozedUntil: null,
  lastSkippedAt: null,
  skipCount: 0,
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("the Vorsorge summary's mark-done", () => {
  const node = <VorsorgeDashboardCard />;
  const seed = (client: QueryClient) =>
    client.setQueryData(queryKeys.measurementReminders(), [REMINDER]);

  it("is offered in the caller's own record", () => {
    const html = render(OWN_RECORD, node, seed);
    expect(html).toContain("Dental check-up");
    expect(html).toContain("Done");
  });

  it("is absent inside somebody else's record below MANAGE", () => {
    // `/checkups` already withheld this exact action; the dashboard summary
    // offering it was the inconsistency that showed nobody had asked.
    for (const access of [READ_ONLY, WRITABLE]) {
      const html = render(access, node, seed);
      expect(html).toContain("Dental check-up");
      expect(html).not.toContain("Done");
    }
  });

  it("is offered to a guardian: the satisfy route answers at MANAGE under measurements", () => {
    const html = render(MANAGING, node, seed);
    expect(html).toContain("Dental check-up");
    expect(html).toContain("Done");
  });
});

/* -------------------------------------------------------------------------- */
/* Documents on an illness episode                                            */
/* -------------------------------------------------------------------------- */

describe("linking a document to an illness episode", () => {
  const node = <EpisodeDocumentsCard episodeId="ep-1" />;

  it("offers the link and the upload in the caller's own record", () => {
    const html = render(OWN_RECORD, node);
    expect(html).toContain(">Link<");
    expect(html).toContain("Upload");
  });

  it("offers neither inside somebody else's record, at every level", () => {
    // Both write through `POST /api/documents/inbound/bulk`, which the vault
    // gates on the same answer throughout — the episode side of the same link
    // had no gate at all, and the upload deep-linked to a page whose own
    // upload control is already withheld. The vault has no delegated write
    // route, so a MANAGE grant is refused the same way.
    for (const access of [READ_ONLY, WRITABLE, MANAGING]) {
      const html = render(access, node);
      expect(html).not.toContain(">Link<");
      expect(html).not.toContain("Upload");
      // The card itself stays — reading the episode's documents is a read.
      // v1.36.x — and the resolver agrees now. This line was true of the
      // intent and false of the route: the card's list query hit
      // `GET /api/documents/inbound`, which resolved the CALLER and 403'd, so
      // the card that "stays" rendered a query-error tile. That GET is
      // delegable; `sharing-surface-guard.test.ts` freezes it and
      // `sharing-delegable-routes.test.ts` drives it.
      expect(html).toContain('data-slot="episode-documents-card"');
    }
  });
});

describe("the capture picker's kinds", () => {
  const ALL = ["measurement", "medication", "mood"] as const;

  const OWNER_CAPS = { canAdd: true, canManageDomain: () => true };
  const WRITER_CAPS = { canAdd: true, canManageDomain: () => false };
  const READER_CAPS = { canAdd: false, canManageDomain: () => false };
  // A guardian: every section with a delegated route answers at MANAGE.
  const GUARDIAN_CAPS = {
    canAdd: true,
    canManageDomain: (domain: string) =>
      delegatedDomains("manage", null, "manage").includes(
        domain as "measurements",
      ),
  };

  it("offers everything in the caller's own record", () => {
    expect(visibleCaptureKinds(OWNER_CAPS, [...ALL])).toEqual([
      "measurement",
      "medication",
      "mood",
    ]);
  });

  it("offers a delegate only what the delegation admits", () => {
    // A reading and a dose are admitted verbs. A mood entry is a MANAGE
    // create, and the server refuses it under a WRITE grant.
    expect(visibleCaptureKinds(WRITER_CAPS, [...ALL])).toEqual([
      "measurement",
      "medication",
    ]);
  });

  it("offers a guardian the mood entry too, because its route answers", () => {
    expect(visibleCaptureKinds(GUARDIAN_CAPS, [...ALL])).toEqual([
      "measurement",
      "medication",
      "mood",
    ]);
  });

  it("offers a read-only delegate nothing", () => {
    expect(visibleCaptureKinds(READER_CAPS, [...ALL])).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The dose-history ledger's row actions                                      */
/* -------------------------------------------------------------------------- */

describe("marking a dose from the dose history", () => {
  const node = (
    <ul>
      <LedgerRowItem
        row={{
          kind: "slot",
          at: "2026-08-04T07:00:00.000Z",
          timeOfDay: "07:00",
          status: "upcoming",
          intake: null,
        }}
        marking={null}
        isToday
        onMark={() => {}}
        onToggleSkipped={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onPin={() => {}}
        onUnpin={() => {}}
      />
    </ul>
  );

  it("offers the owner take beside the kebab that holds the rest", () => {
    const html = render(OWN_RECORD, node);
    expect(html).toContain('data-slot="ledger-mark-taken"');
    expect(html).toContain('data-slot="ledger-row-menu"');
  });

  it("offers a write delegate BOTH markings, and no row menu", () => {
    // Taken and skipped are one admitted verb, not two — the medication card
    // has always offered the pair. This surface offered a delegate only the
    // first, because skip lives in the kebab and the kebab also holds edit,
    // re-attribute and delete, which are the owner's. So skip gets its own
    // control here rather than the menu opening up.
    const html = render(WRITABLE, node);
    expect(html).toContain('data-slot="ledger-mark-taken"');
    expect(html).toContain('data-slot="ledger-mark-skipped"');
    expect(html).not.toContain('data-slot="ledger-row-menu"');
  });

  it("offers a read-only delegate neither", () => {
    const html = render(READ_ONLY, node);
    expect(html).not.toContain('data-slot="ledger-mark-taken"');
    expect(html).not.toContain('data-slot="ledger-mark-skipped"');
    expect(html).not.toContain('data-slot="ledger-row-menu"');
    // The row itself stays — reading the history is a read.
    expect(html).toContain('data-slot="ledger-row"');
  });
});

/* -------------------------------------------------------------------------- */
/* The first-paint window                                                     */
/* -------------------------------------------------------------------------- */

describe("a form opened before the record answered", () => {
  /**
   * The gap both capture surfaces had. `resolveRecordCapabilities(undefined)`
   * reads as the caller's own record until `/api/auth/me` settles, and the
   * switch flow ends in a hard reload that wipes the persisted cache — so the
   * window is widest exactly when a delegate arrives. Both surfaces gated the
   * CHOOSER at tap time and never asked again, which left the form standing
   * once the answer landed.
   *
   * These assert the re-derivation, which is what closes it. What they cannot
   * assert is the render, because there is no click here: the SSR note at the
   * top of the file applies.
   */
  it("withdraws a capture form the shrunken offer no longer holds", () => {
    // The chooser offered three; the answer arrives and offers two.
    expect(admittedCaptureKind("mood", ["measurement", "medication"])).toBe(
      null,
    );
    // …and leaves an admitted one exactly where it was.
    expect(
      admittedCaptureKind("medication", ["measurement", "medication"]),
    ).toBe("medication");
    expect(admittedCaptureKind(null, ["measurement"])).toBe(null);
  });

  it("withdraws a dashboard quick-entry sheet the delegation does not admit", () => {
    const DELEGATE = { canAdd: true, canManageDomain: () => false };
    expect(admittedQuickEntry("mood", DELEGATE)).toBe(null);
    expect(admittedQuickEntry("measurement", DELEGATE)).toBe("measurement");
    expect(admittedQuickEntry("medicationIntake", DELEGATE)).toBe(
      "medicationIntake",
    );
  });

  it("keeps the mood sheet for a guardian, whose mind routes answer at MANAGE", () => {
    const GUARDIAN = {
      canAdd: true,
      canManageDomain: (domain: string) => domain === "mind",
    };
    expect(admittedQuickEntry("mood", GUARDIAN)).toBe("mood");
  });

  it("withdraws every quick-entry sheet from a read-only delegate", () => {
    const READER = { canAdd: false, canManageDomain: () => false };
    for (const sheet of ["measurement", "mood", "medicationIntake"] as const) {
      expect(admittedQuickEntry(sheet, READER), sheet).toBe(null);
    }
  });

  it("leaves the owner's own sheets alone", () => {
    const OWNER_CAPS = { canAdd: true, canManageDomain: () => true };
    for (const sheet of ["measurement", "mood", "medicationIntake"] as const) {
      expect(admittedQuickEntry(sheet, OWNER_CAPS), sheet).toBe(sheet);
    }
    expect(admittedQuickEntry(null, OWNER_CAPS)).toBe(null);
  });
});

/* -------------------------------------------------------------------------- */
/* The immunization log                                                       */
/* -------------------------------------------------------------------------- */

describe("the immunization log's add, edit and delete", () => {
  const DOSE = {
    id: "dose-1",
    occurredAt: "2026-03-01T00:00:00.000Z",
    antigenSlug: null,
    vaccineName: "Tetanus",
    doseNumber: null,
    seriesDoses: null,
    lotNumber: null,
    site: null,
    catalogEntry: null,
    series: [],
    practitioner: null,
    encounter: null,
    reminderId: null,
    note: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
  };

  const seedList = (client: QueryClient) => {
    client.setQueryData(queryKeys.vaccinationList(null), {
      vaccinations: [DOSE],
    });
  };

  it("offers all three in the caller's own record", () => {
    const html = render(OWN_RECORD, <VaccinationsView />, seedList);
    expect(html).toContain('data-slot="vaccination-add"');
    // The row opens the edit sheet, which is where the delete lives.
    expect(html).toContain('role="button"');
  });

  it("offers a read-only delegate none of them", () => {
    // `POST /api/vaccinations` is WRITE and everything else is MANAGE, so a
    // READ delegate was being shown three controls and refused by all three.
    const html = render(
      grant("read", ["profile"]),
      <VaccinationsView />,
      seedList,
    );
    expect(html).not.toContain('data-slot="vaccination-add"');
    expect(html).not.toContain('role="button"');
  });

  it("offers a WRITE delegate the add and not the row", () => {
    const html = render(
      grant("write", ["profile"]),
      <VaccinationsView />,
      seedList,
    );
    expect(html).toContain('data-slot="vaccination-add"');
    expect(html, "editing and deleting a dose are MANAGE").not.toContain(
      'role="button"',
    );
  });

  it("offers a MANAGE delegate holding the section both", () => {
    const html = render(
      grant("manage", ["profile"]),
      <VaccinationsView />,
      seedList,
    );
    expect(html).toContain('data-slot="vaccination-add"');
    expect(html).toContain('role="button"');
  });

  it("offers a MANAGE delegate outside the section neither", () => {
    // The page is presentable to a `profile` grant; a grant scoped elsewhere
    // that still lands on the URL gets a log it can read and nothing else.
    const html = render(
      grant("manage", ["labs"]),
      <VaccinationsView />,
      seedList,
    );
    expect(html).not.toContain('data-slot="vaccination-add"');
    expect(html).not.toContain('role="button"');
  });

  it("offers the empty state's add on the same rule", () => {
    const seedEmpty = (client: QueryClient) => {
      client.setQueryData(queryKeys.vaccinationList(null), {
        vaccinations: [],
      });
    };
    expect(render(OWN_RECORD, <VaccinationsView />, seedEmpty)).toContain(
      'data-slot="vaccination-add-empty"',
    );
    expect(
      render(grant("read", ["profile"]), <VaccinationsView />, seedEmpty),
    ).not.toContain('data-slot="vaccination-add-empty"');
  });
});
