/**
 * Redaction guard for the operator's support report.
 *
 * The report is pasted into public issues. This seeds every free-text slot it
 * carries with something it must never print (an account's email, id and
 * username, a token, a URL, a foreign host, an address, a request id) and
 * proves two things:
 *
 *   1. the finished text contains none of them;
 *   2. every redaction step is load-bearing: with any single step dropped,
 *      the seed of its class reaches the output. A step that can be removed
 *      without a test going red would be a step nobody notices is gone.
 */
import { describe, expect, it } from "vitest";

import {
  buildSupportReportText,
  errorClassOf,
  renderSupportReport,
  summariseProblemEvents,
  type SupportReportFacts,
} from "../report";
import {
  HOST_TLDS,
  redactSupportText,
  SUPPORT_REDACTION_STEPS,
  type SupportRedactionContext,
} from "../redact";
import type { WideEvent } from "@/lib/logging/types";
import { locales, type Locale } from "@/lib/i18n/config";

const ACCOUNT_EMAIL = "anna.schmidt@example.org";
const ACCOUNT_ID = "cmq7x0abcdefghijklmnopqrs";
const ACCOUNT_USERNAME = "annaschmidt";
const ACCOUNT_NAME = "Anna Schmidt";

/** One seed per step; each is caught by its own step and by no other. */
const SEEDS = {
  "known-values": ACCOUNT_USERNAME,
  secrets: "sk-ant-api03-Zq9Xw8Vu7Ts6",
  urls: "smb://nas/backups",
  emails: "someone@",
  ids: "5d8e1b72-9a8c-49b7-801c-1dd42ba79dcc",
  "ip-addresses": "192.168.17.42",
  "host-names": "gotify.home.arpa",
} as const;

const CONTEXT: SupportRedactionContext = {
  knownValues: [ACCOUNT_ID, ACCOUNT_USERNAME, ACCOUNT_EMAIL, ACCOUNT_NAME],
};

function seededFacts(): SupportReportFacts {
  return {
    generatedAt: "2026-10-15T10:00:00.000Z",
    build: {
      version: "1.43.0",
      buildSha: "abc1234",
      builtAt: "2026-10-15T08:00:00.000Z",
      node: "v22.11.0",
      processType: "web,worker",
      heapLimitMb: 792,
      containerMemoryLimitMb: 1536,
      uptimeSeconds: 7260,
    },
    database: {
      version: "16.4",
      timezone: "Etc/UTC",
      sizeBytes: 104857600,
      lastMigration: "0410_relation_links",
      lastMigrationAt: "2026-10-15T08:05:00.000Z",
      unfinishedMigrations: 0,
    },
    config: [
      ["Secure cookie flag", "yes"],
      // A value that should only ever be yes/no, carrying a URL anyway.
      ["AI provider types chosen by accounts", `OPENAI 1, ${SEEDS.urls}`],
    ],
    jobs: {
      workerInThisProcess: true,
      workerRunning: true,
      workerLastHeartbeat: "2026-10-15T09:59:00.000Z",
      newestFinishedJobAt: "2026-10-15T09:59:30.000Z",
      failing: [
        {
          queue: "environment-fetch",
          failures: 3,
          lastFailedAt: "2026-10-15T09:00:00.000Z",
          errorClass: `Error for ${ACCOUNT_EMAIL}`,
        },
      ],
    },
    accounts: { total: 2, read: 2 },
    connections: [
      {
        provider: "withings",
        state: "action_required",
        reason: "reauth_required",
        accounts: [2],
      },
      {
        provider: "oura",
        state: "degraded",
        reason: `provider_errors ${SEEDS["ip-addresses"]}`,
        accounts: [1],
      },
    ],
    incidents: [
      {
        provider: "nightscout",
        reason: `unexpected_silence ${SEEDS["host-names"]}`,
        openedAt: "2026-10-14T00:00:00.000Z",
        announced: true,
        account: 1,
      },
    ],
    ai: {
      defaultLevel: "STANDARD",
      maxLevel: "FULL",
      levels: [["instance default", 2]],
      providers: [
        {
          provider: "LOCAL",
          ok: 1,
          failing: 1,
          authFailed: 0,
          paused: 0,
          lastFailureAt: "2026-10-15T07:00:00.000Z",
          lastStatus: 502,
        },
      ],
    },
    notifications: [
      {
        channel: "NTFY",
        ok: 10,
        error: 2,
        skipped: 0,
        topReasons: [[`http_500 ${SEEDS.ids}`, 2]],
      },
    ],
    backups: {
      newestLocalAt: "2026-10-12T03:00:00.000Z",
      localCopies: 2,
      lastLocalRun: {
        at: "2026-10-12T03:10:00.000Z",
        state: "completed",
        errorClass: null,
      },
      offhostConfigured: true,
      offhostNewestAt: "2026-10-15T02:00:00.000Z",
      offhostOldestAt: "2026-10-15T01:00:00.000Z",
      offhostAccounts: 2,
      offhostNeverStored: 0,
      lastOffhostRun: null,
      lastRestoreDrill: {
        at: "2026-10-01T04:11:00.000Z",
        state: "failed",
        errorClass: `TypeError Bearer ${SEEDS.secrets}`,
      },
    },
    errors: {
      ringSize: 3,
      ringMax: 1000,
      top: [
        {
          action: `integration.sync.${ACCOUNT_ID}`,
          level: "error",
          count: 2,
          lastSeen: "2026-10-15T09:30:00.000Z",
          errorClass: `${ACCOUNT_USERNAME} Error`,
        },
        {
          action: "notification.send",
          level: "warn",
          count: 1,
          lastSeen: "2026-10-15T09:20:00.000Z",
          errorClass: `someone@mailbox.org ${ACCOUNT_NAME}`,
        },
      ],
    },
  };
}

const FORBIDDEN = [
  ACCOUNT_EMAIL,
  ACCOUNT_ID,
  ACCOUNT_USERNAME,
  ACCOUNT_NAME,
  ...Object.values(SEEDS),
];

describe("support report redaction", () => {
  it("prints none of the seeded values", () => {
    const text = buildSupportReportText(seededFacts(), CONTEXT);
    for (const value of FORBIDDEN) {
      expect(text.toLowerCase(), value).not.toContain(value.toLowerCase());
    }
    // The report itself survived: sections, accounts as numbers, dates.
    expect(text).toContain("# HealthLog support report");
    expect(text).toContain("Account 2");
    expect(text).toContain("2026-10-15T09:30:00.000Z");
    expect(text).toContain("0410_relation_links");
    expect(text).toContain("environment-fetch");
  });

  it("says what to raise when the heap limit is low, and keeps it through redaction", () => {
    const facts = seededFacts();
    const low = redactSupportText(
      renderSupportReport({
        ...facts,
        build: { ...facts.build, heapLimitMb: 524 },
      }),
      CONTEXT,
    );
    expect(low).toContain("- Heap limit: 524 MB");
    expect(low).toContain(
      "- Heap limit note: The heap limit of 524 MB is below 700 MB.",
    );
    expect(low).toContain("APP_MEMORY_LIMIT=1536m in .env");
    expect(low).toContain("docker compose up -d.");
    const enough = redactSupportText(renderSupportReport(facts), CONTEXT);
    expect(enough).not.toContain("Heap limit note");
  });

  it("says when the container runs below the supported memory floor", () => {
    const facts = seededFacts();
    const below = redactSupportText(
      renderSupportReport({
        ...facts,
        build: { ...facts.build, containerMemoryLimitMb: 1024 },
      }),
      CONTEXT,
    );
    expect(below).toContain("- Container memory limit: 1024 MB");
    expect(below).toContain(
      "- Memory note: Below the supported floor. The container memory limit of 1024 MB is below the supported floor of 1536 MB.",
    );
    const atFloor = renderSupportReport(facts);
    expect(atFloor).toContain("- Container memory limit: 1536 MB");
    expect(atFloor).not.toContain("Memory note");
    const unknown = renderSupportReport({
      ...facts,
      build: { ...facts.build, containerMemoryLimitMb: null },
    });
    expect(unknown).toContain("- Container memory limit: none or unreadable");
    expect(unknown).not.toContain("Memory note");
  });

  it("the seeds really are in the unredacted text", () => {
    const raw = renderSupportReport(seededFacts());
    for (const value of FORBIDDEN) expect(raw).toContain(value);
  });

  it.each(SUPPORT_REDACTION_STEPS.map((s) => s.name))(
    "goes red without the %s step",
    (name) => {
      const seed = SEEDS[name as keyof typeof SEEDS];
      expect(seed, `no seed for step ${name}`).toBeDefined();
      const without = SUPPORT_REDACTION_STEPS.filter((s) => s.name !== name);
      const text = redactSupportText(
        renderSupportReport(seededFacts()),
        CONTEXT,
        without,
      );
      expect(text.toLowerCase()).toContain(seed.toLowerCase());
    },
  );

  it("has a seed for every step, so a new step needs one", () => {
    expect(Object.keys(SEEDS).sort()).toEqual(
      SUPPORT_REDACTION_STEPS.map((s) => s.name).sort(),
    );
  });

  it("leaves dates, versions and clock times alone", () => {
    const text = redactSupportText(
      "- Node: v22.11.0\n- Built at: 2026-10-15T08:00:00.000Z\n- Version: 1.43.0",
      CONTEXT,
    );
    expect(text).toContain("v22.11.0");
    expect(text).toContain("2026-10-15T08:00:00.000Z");
    expect(text).toContain("1.43.0");
  });
});

describe("error classes never carry the message", () => {
  it("names the class or code and drops the rest", () => {
    expect(
      errorClassOf(
        `TypeError: fetch failed for https://gotify.home.arpa/?token=abc (${ACCOUNT_EMAIL})`,
      ),
    ).toBe("TypeError");
    expect(errorClassOf("connect ECONNREFUSED 192.168.17.42:5432")).toBe(
      "ECONNREFUSED",
    );
    expect(
      errorClassOf("Invalid `prisma.user.update()` invocation: P2002 unique"),
    ).toBe("P2002");
    expect(errorClassOf("Withings answered HTTP 503 for annaschmidt")).toBe(
      "503",
    );
    expect(errorClassOf("job timed out: did not finish within 1 h")).toBe(
      "timeout",
    );
    // A statement past its timeout, as Prisma words it: the SQLSTATE is the
    // class, not the bare "Error" it used to read as.
    expect(
      errorClassOf(
        "\nInvalid `prisma.measurement.findMany()` invocation:\n\n\nDatabase error. Code: `57014`. Message: `canceling statement due to statement timeout`",
      ),
    ).toBe("statement_timeout");
    expect(
      errorClassOf(
        "compaction-tombstone-purge: stopped while deleting a batch (lock_timeout)",
      ),
    ).toBe("lock_timeout");
    expect(errorClassOf("timeout exceeded when trying to connect")).toBe(
      "pool_timeout",
    );
    expect(errorClassOf("anything at all, an email a@b.co")).toBe("Error");
    expect(errorClassOf(null)).toBe("unknown");
  });

  it("groups problem events by action without reading their messages", () => {
    const event = (over: Partial<WideEvent>): WideEvent => ({
      timestamp: "2026-10-15T09:00:00.000Z",
      duration_ms: 5,
      request_id: SEEDS.ids,
      trace_id: "t",
      level: "error",
      kind: "http",
      service: "healthlog",
      environment: "test",
      ...over,
    });
    const top = summariseProblemEvents([
      event({
        action: { name: "measurement.batch.ingest" },
        error: {
          type: "PrismaClientKnownRequestError",
          code: "P2002",
          message: `duplicate for ${ACCOUNT_EMAIL}`,
        },
      }),
      event({
        timestamp: "2026-10-15T09:05:00.000Z",
        action: { name: "measurement.batch.ingest" },
        error: { type: "Error", message: "Bearer hlk_secret_value_here" },
      }),
      event({
        level: "warn",
        http: { method: "GET", path: "/x", route: "/x", status: 404 },
      }),
    ]);
    expect(top[0]).toEqual({
      action: "measurement.batch.ingest",
      level: "error",
      count: 2,
      lastSeen: "2026-10-15T09:05:00.000Z",
      errorClass: "Error",
    });
    expect(top[1]).toMatchObject({
      action: "http GET 404",
      errorClass: "HTTP 404",
    });
    expect(JSON.stringify(top)).not.toContain(ACCOUNT_EMAIL);
    expect(JSON.stringify(top)).not.toContain("hlk_secret");
    expect(JSON.stringify(top)).not.toContain(SEEDS.ids);
  });
});

describe("host names under every app language's country codes", () => {
  // Where each shipped language is at home. A new locale fails here until its
  // countries are listed, and a listed country fails until HOST_TLDS has it.
  const HOST_TLD_LOCALE_REGIONS: Record<Locale, readonly string[]> = {
    de: ["de", "at", "ch", "li", "lu", "be"],
    en: ["uk", "ie", "us", "ca", "au", "nz"],
    fr: ["fr", "be", "ch", "lu", "ca"],
    es: ["es", "mx", "ar"],
    it: ["it", "ch"],
    pl: ["pl"],
    ko: ["kr"],
    nl: ["nl", "be"],
    "pt-BR": ["br", "pt", "ao", "mz"],
    ru: ["ru", "by", "kz", "ua"],
  };

  it("covers every shipped locale", () => {
    expect(Object.keys(HOST_TLD_LOCALE_REGIONS).sort()).toEqual(
      [...locales].sort(),
    );
  });

  it.each(Object.entries(HOST_TLD_LOCALE_REGIONS))(
    "redacts a host under each of %s's country codes",
    (_locale, tlds) => {
      for (const tld of tlds) {
        expect(HOST_TLDS, tld).toContain(tld);
        const text = redactSupportText(`reached nas.familie.${tld} late`, {
          knownValues: [],
        });
        expect(text, tld).toBe("reached [host] late");
      }
    },
  );

  it("redacts Brazilian and Portuguese hosts, with a port or a second-level registry", () => {
    const cases = [
      "saude.minhacasa.br:3000",
      "vida.example.com.br",
      "healthlog.casa.pt",
      "nas.lan.com.pt:8443",
    ];
    for (const host of cases) {
      const text = redactSupportText(`unexpected_silence ${host}`, {
        knownValues: [],
      });
      expect(text, host).not.toMatch(/minhacasa|example|casa|lan\.com/);
      expect(text).toContain("[host]");
    }
  });

  it("still leaves report prose and action names alone", () => {
    const text = redactSupportText(
      "- Actions: mental-health.create, coach.budget.exceeded, measurement.batch.ingest\n- Node: v22.11.0",
      { knownValues: [] },
    );
    expect(text).toContain("mental-health.create");
    expect(text).toContain("coach.budget.exceeded");
    expect(text).toContain("measurement.batch.ingest");
  });
});
