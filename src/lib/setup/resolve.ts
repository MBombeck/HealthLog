/**
 * The setup state, resolved on the server for one account (1.50): where the
 * person flow stands, the rows of the setup card, and for an admin on a
 * browser session the instance setup and the rows of Admin › Setup.
 *
 * Every row is detected from the domain it is about (a medication exists, a
 * factor is enrolled, the relay is on), so a row completes however it was
 * done, in the flow, in Settings or in the iPhone app. A "no" is a value,
 * shown as settled and never asked again.
 */
import { prisma } from "@/lib/db";
import { loadAiCapabilities } from "@/lib/ai/capabilities/load";
import {
  parseServerSetupSteps,
  type ServerSetupStepId,
} from "@/lib/admin/server-setup";
import { serverSetupOfferedHere } from "@/lib/admin/server-setup-store";
import { resolveMfaEnrollment } from "@/lib/auth/mfa-enrollment";
import { isOidcConfigured } from "@/lib/auth/oidc";
import { offhostBackupConfigured } from "@/lib/jobs/offhost-backup";
import { isEmailConfigured } from "@/lib/notifications/senders/email-config";
import { getOuraClientCredentials } from "@/lib/oura/credentials";
import { getPolarClientCredentials } from "@/lib/polar/credentials";
import { getStravaClientCredentials } from "@/lib/strava/credentials";
import { accountPushState } from "@/lib/push-relay/capability";
import { readRecoveryKit } from "@/lib/recovery/kit";
import { loadOnboardingOffers } from "@/lib/onboarding/load-offers";
import { activeGuardianWhere } from "@/lib/managed-profiles/guardian-where";
import {
  hasEnteredOnboardingFlow,
  readHeldUnitPreferences,
} from "@/lib/onboarding/needs";
import {
  loadOnboardingRecordRow,
  toOnboardingStateDto,
} from "@/lib/onboarding/needs-store";
import {
  ledgerStepOf,
  parsePinnedPlan,
  planOf,
  resumeScreen,
  screenOrder,
  segmentOf,
  type FlowState,
} from "@/lib/onboarding/wizard-steps";

import type {
  InstanceSetupState,
  InstanceTaskId,
  PersonSetupState,
  PersonTaskId,
  SetupStateDto,
  SetupTask,
  SetupTaskStatus,
  SetupTaskValue,
} from "./types";

/** A deadline closer than this shows as a warning. */
const DEADLINE_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

function task<Id extends string>(
  id: Id,
  status: SetupTaskStatus,
  extra: Partial<Omit<SetupTask<Id>, "id" | "status">> = {},
): SetupTask<Id> {
  return {
    id,
    status,
    value: extra.value ?? null,
    deadline: extra.deadline ?? null,
    count: extra.count ?? null,
  };
}

function deadlineStatus(deadline: string | null, now: Date): SetupTaskStatus {
  if (!deadline) return "todo";
  return new Date(deadline).getTime() - now.getTime() < DEADLINE_WARNING_MS
    ? "warning"
    : "todo";
}

interface AccountRow {
  id: string;
  role: string;
  createdAt: Date;
  totpConfirmedAt: Date | null;
  mfaEnforced: boolean;
  heightCm: number | null;
  dateOfBirth: Date | null;
  gender: string | null;
  glucoseUnit: string | null;
  unitPreference: string | null;
  healthKitLastSyncedAt: Date | null;
  polarAccessTokenEncrypted: string | null;
  ouraAccessTokenEncrypted: string | null;
  stravaAccessTokenEncrypted: string | null;
  garminApiKeyEncrypted: string | null;
  nightscoutUrlEncrypted: string | null;
}

const ACCOUNT_SELECT = {
  id: true,
  role: true,
  createdAt: true,
  totpConfirmedAt: true,
  mfaEnforced: true,
  heightCm: true,
  dateOfBirth: true,
  gender: true,
  glucoseUnit: true,
  unitPreference: true,
  healthKitLastSyncedAt: true,
  polarAccessTokenEncrypted: true,
  ouraAccessTokenEncrypted: true,
  stravaAccessTokenEncrypted: true,
  garminApiKeyEncrypted: true,
  nightscoutUrlEncrypted: true,
} as const;

async function secondFactorTask<Id extends "second-factor">(
  account: AccountRow,
  now: Date,
): Promise<SetupTask<Id>> {
  const [passkeys, keys, enrollment] = await Promise.all([
    prisma.passkey.count({ where: { userId: account.id } }),
    prisma.webauthnMfaCredential.count({ where: { userId: account.id } }),
    resolveMfaEnrollment(account.id, account),
  ]);
  if (passkeys > 0 || keys > 0) {
    return task("second-factor" as Id, "done", { value: "passkey" });
  }
  if (account.totpConfirmedAt) {
    return task("second-factor" as Id, "done", { value: "authenticator" });
  }
  const deadline =
    enrollment.state === "grace" && enrollment.dueAt
      ? new Date(enrollment.dueAt).toISOString()
      : null;
  return task("second-factor" as Id, deadlineStatus(deadline, now), {
    deadline,
  });
}

async function personTasks(
  account: AccountRow,
  flow: FlowState,
  now: Date,
): Promise<Array<SetupTask<PersonTaskId>>> {
  const userId = account.id;
  const forSomeoneElse = flow.needs.recordTarget === "someone-else";
  const [
    medication,
    reading,
    connections,
    channels,
    managed,
    secondFactor,
    ai,
  ] = await Promise.all([
    prisma.medication.findFirst({ where: { userId }, select: { id: true } }),
    prisma.measurement.findFirst({
      where: { userId, deletedAt: null },
      select: { id: true },
    }),
    Promise.all([
      prisma.withingsConnection.count({ where: { userId } }),
      prisma.whoopConnection.count({ where: { userId } }),
      prisma.googleHealthConnection.count({ where: { userId } }),
    ]),
    prisma.notificationChannel.count({
      where: { userId, enabled: true, type: { in: ["TELEGRAM", "NTFY"] } },
    }),
    prisma.accountGrant.count({
      where: {
        granteeId: userId,
        grantor: { managedProfileAt: { not: null } },
        ...activeGuardianWhere(now),
      },
    }),
    secondFactorTask(account, now),
    loadAiCapabilities({
      recordId: userId,
      authority: {
        origin: "owner",
        recordUserId: userId,
        actorUserId: userId,
        grantId: null,
      },
      sections: null,
      recordKind: "self",
    }).catch(() => null),
  ]);

  const tasks: Array<SetupTask<PersonTaskId>> = [];
  const resume = resumeScreen(flow);
  if (hasEnteredOnboardingFlow({ needs: flow.needs, completedAt: null })) {
    if (resume) tasks.push(task("resume", "todo"));
  }
  if (!forSomeoneElse) {
    tasks.push(task("medication", medication ? "done" : "todo"));
  }
  tasks.push(secondFactor as SetupTask<PersonTaskId>);
  if (!forSomeoneElse) {
    const aboutYou =
      account.heightCm !== null &&
      account.dateOfBirth !== null &&
      account.gender !== null;
    tasks.push(task("about-you", aboutYou ? "done" : "todo"));
    tasks.push(task("reading", reading ? "done" : "todo"));
    const sourceConnected =
      account.healthKitLastSyncedAt !== null ||
      account.polarAccessTokenEncrypted !== null ||
      account.ouraAccessTokenEncrypted !== null ||
      account.stravaAccessTokenEncrypted !== null ||
      account.garminApiKeyEncrypted !== null ||
      account.nightscoutUrlEncrypted !== null ||
      connections.some((count) => count > 0);
    tasks.push(task("source", sourceConnected ? "done" : "todo"));
    tasks.push(task("second-channel", channels > 0 ? "done" : "todo"));
    const coach = ai?.capabilities.coach;
    if (coach && coach.reason !== "operator_disabled") {
      if (coach.available) {
        tasks.push(task("coach", "done", { value: "on" }));
      } else if (coach.reason === "user_disabled") {
        tasks.push(task("coach", "declined", { value: "off" }));
      } else if (coach.reason === "consent_required") {
        tasks.push(task("coach", "todo"));
      } else if (coach.reason === "no_provider" && ai.provider.canConfigure) {
        tasks.push(task("coach", "todo", { value: "add-key" }));
      }
    }
  }
  const wantsProfile =
    flow.needs.recordTarget === "someone-else" ||
    flow.needs.recordTarget === "both";
  if (wantsProfile) {
    tasks.push(task("managed-profile", managed > 0 ? "done" : "todo"));
  }
  return tasks;
}

async function resolvePerson(
  account: AccountRow,
  now: Date,
): Promise<{ person: PersonSetupState; aiOffered: boolean }> {
  const [row, offers, extra] = await Promise.all([
    loadOnboardingRecordRow(prisma, account.id),
    loadOnboardingOffers(account.id),
    prisma.onboardingRecord.findUnique({
      where: { userId: account.id },
      select: { planJson: true, cardDismissedAt: true },
    }),
  ]);
  const demo = process.env.DEMO_MODE === "true";
  const state = toOnboardingStateDto(
    row,
    readHeldUnitPreferences(account),
    offers,
  );
  const pinned = demo
    ? (["you"] as const).slice()
    : parsePinnedPlan(extra?.planJson ?? null);
  const flow: FlowState = { ...state, plan: pinned };
  const currentStep = resumeScreen(flow);
  const order = screenOrder(flow);
  const tasks = demo ? [] : await personTasks(account, flow, now);
  const cardDismissed = extra?.cardDismissedAt != null;
  const openTasks = tasks.some(
    (row) => row.status === "todo" || row.status === "warning",
  );
  return {
    aiOffered: offers.ai,
    person: {
      status: currentStep === null ? "done" : "pending",
      currentStep,
      segments: planOf(flow).map((segment) => ({
        id: segment,
        screens: order
          .filter((screen) => segmentOf(screen) === segment)
          .map((screen) => ({
            id: screen,
            status:
              state.steps.find(
                (step) =>
                  step.id === ledgerStepOf(screen, state.needs.recordTarget),
              )?.status ?? "pending",
          })),
      })),
      planned: pinned !== null,
      // Only an account that started the 1.50 flow gets the card; everyone
      // finds the same rows in Settings › Account › Setup.
      cardShown: !demo && pinned !== null && !cardDismissed && openTasks,
      cardDismissed,
      tasks,
    },
  };
}

async function resolveInstance(
  account: AccountRow,
  relayDecision: "on" | "off" | "undecided",
  now: Date,
): Promise<InstanceSetupState> {
  const [settings, kit, shared, secondFactor] = await Promise.all([
    prisma.appSettings.findUnique({
      where: { id: "singleton" },
      select: {
        registrationEnabled: true,
        assistantEnabled: true,
        adminAiKeyEncrypted: true,
        glitchtipEnabled: true,
        serverSetupCompletedAt: true,
        serverSetupStepsJson: true,
      },
    }),
    readRecoveryKit().catch(() => null),
    Promise.all([
      getPolarClientCredentials(account.id).then(Boolean),
      getOuraClientCredentials(account.id).then(Boolean),
      getStravaClientCredentials(account.id).then(Boolean),
    ]).catch(() => [false, false, false]),
    secondFactorTask(account, now),
  ]);
  const steps = parseServerSetupSteps(settings?.serverSetupStepsJson ?? null);
  const stepStatus = (id: ServerSetupStepId) =>
    steps.find((step) => step.id === id)?.status ?? "pending";

  const tasks: Array<SetupTask<InstanceTaskId>> = [
    secondFactor as SetupTask<InstanceTaskId>,
    task("signups", "done", {
      value: settings?.registrationEnabled === false ? "invited" : "anyone",
    }),
  ];
  tasks.push(
    relayDecision === "on"
      ? task("relay", "done", { value: "on" })
      : relayDecision === "off"
        ? task("relay", "declined", { value: "off" })
        : task("relay", "todo"),
  );
  const aiValue: SetupTaskValue =
    settings?.assistantEnabled === false
      ? "off"
      : settings?.adminAiKeyEncrypted
        ? "server-key"
        : "own-keys";
  tasks.push(
    aiValue === "off"
      ? task("ai", "declined", { value: "off" })
      : task(
          "ai",
          stepStatus("ai") === "done" || aiValue === "server-key"
            ? "done"
            : "todo",
          { value: aiValue },
        ),
  );
  if (kit) {
    tasks.push(
      !kit.due
        ? task("recovery", "done", { value: "saved" })
        : kit.confirmedAt
          ? task("recovery", "warning", { value: "key-added" })
          : task("recovery", "todo"),
    );
  }
  tasks.push(task("email", isEmailConfigured() ? "done" : "todo"));
  tasks.push(task("sso", isOidcConfigured() ? "done" : "todo"));
  const services = shared.filter(Boolean).length;
  tasks.push(
    task("services", services > 0 ? "done" : "todo", {
      count: { done: services, total: shared.length },
    }),
  );
  tasks.push(task("backups", offhostBackupConfigured() ? "done" : "todo"));
  tasks.push(
    settings?.glitchtipEnabled
      ? task("error-reporting", "done", { value: "on" })
      : task("error-reporting", "declined", { value: "off" }),
  );

  const currentStep =
    settings?.serverSetupCompletedAt != null
      ? null
      : (steps.find((step) => step.status === "pending")?.id ?? null);
  return {
    status: settings?.serverSetupCompletedAt != null ? "done" : "pending",
    currentStep,
    steps: steps.map(({ id, status }) => ({ id, status })),
    tasks,
  };
}

/**
 * The whole state for one account. `browser` is true for a cookie session:
 * the instance half is published to an admin there only, never to a Bearer
 * token (the app is not an admin client).
 */
export async function resolveSetupState(
  userId: string,
  options: { browser: boolean },
  now: Date = new Date(),
): Promise<SetupStateDto> {
  const account = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: ACCOUNT_SELECT,
  });
  const isAdmin = account.role === "ADMIN";
  const [{ person, aiOffered }, push] = await Promise.all([
    resolvePerson(account, now),
    accountPushState(userId, undefined, { isAdmin }),
  ]);
  const relay = push.relay.operatorDecision;
  const instance =
    isAdmin && options.browser && serverSetupOfferedHere()
      ? await resolveInstance(account, relay, now)
      : null;
  return { person, instance, offers: { relay, ai: aiOffered } };
}
