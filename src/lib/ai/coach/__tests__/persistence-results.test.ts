import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * v1.39.4 — the dialog fields of the provenance survive a reload, malformed
 * entries are dropped one by one, the tables are sealed into their own
 * column, and the owner-narrowed read serves each table whole or names why
 * it does not.
 */
const txCreate = {
  coachConversation: { update: vi.fn() },
  coachMessage: { create: vi.fn() },
};
const findFirst = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: vi.fn(async (cb: (tx: typeof txCreate) => Promise<unknown>) =>
      cb(txCreate),
    ),
    coachMessage: { findFirst: (...args: unknown[]) => findFirst(...args) },
  },
}));
vi.mock("../bytes-codec", () => ({
  encryptToBytes: vi.fn((text: string) =>
    new TextEncoder().encode(`enc:${text}`),
  ),
  decryptFromBytes: vi.fn((bytes: Uint8Array) => {
    const text = new TextDecoder().decode(bytes);
    if (!text.startsWith("enc:")) throw new Error("bad ciphertext");
    return text.slice(4);
  }),
}));

import {
  RESULTS_MAX_BYTES,
  appendMessage,
  readMessageResults,
} from "../persistence";
import type {
  CoachProvenance,
  CoachResultMeta,
  CoachResultTable,
} from "../types";

const META: CoachResultMeta = {
  ref: "r1",
  source: {
    tool: "get_metric_series",
    domain: "bp",
    window: "last30days",
    period: "current",
    granularity: "day",
  },
  shape: "timeSeries",
  titleKey: "coach.result.title.metricByPeriod",
  title: "Blood pressure by day",
  rowCount: 2,
  chartKind: "line",
  displayed: true,
};

const TABLE: CoachResultTable = {
  ...META,
  columns: [
    {
      key: "period",
      kind: "period",
      labelKey: "coach.result.column.day",
      label: "Day",
    },
    {
      key: "sys",
      kind: "number",
      labelKey: "coach.result.column.systolic",
      label: "Systolic",
      unit: "mmHg",
      decimals: 0,
    },
  ],
  rows: [
    ["2026-09-01", 128],
    ["2026-09-02", null],
  ],
  truncated: false,
  chart: { kind: "line", x: "period", series: ["sys"] },
};

const SLEEP_META: CoachResultMeta = {
  ...META,
  ref: "r2",
  source: { ...META.source, domain: "sleep", tool: "get_sleep" },
  title: "Sleep by night",
};

const FULL: CoachProvenance = {
  windows: ["last30days"],
  metrics: ["bp"],
  steps: [
    {
      id: "s1",
      tool: "get_metric_series",
      labelKey: "coach.step.read",
      label: "Blood pressure, last 30 days",
      domain: "bp",
      window: "last30days",
      status: "done",
      count: 42,
      resultRef: "r1",
    },
  ],
  method: {
    entries: [
      { domain: "bp", window: "last30days", count: 42, aggregation: "mean" },
    ],
    text: "Blood pressure, last 30 days: 42 readings",
  },
  results: [META],
  followUps: [
    {
      id: "f1",
      kind: "previous_period",
      labelKey: "coach.followUp.previousPeriod",
      label: "Compare with the period before",
      anchor: { ref: "r1", domain: "bp", window: "last30days" },
      reuse: false,
      origin: "server",
    },
  ],
  clarification: {
    kind: "window",
    choices: [
      {
        id: "c1",
        labelKey: "coach.clarify.window.last30days",
        label: "Last 30 days",
        value: { window: "last30days" },
      },
    ],
    freeText: true,
  },
  forcedFinal: true,
  continuationOf: "m0",
};

function stubEchoCreate(overrideJson?: string): void {
  txCreate.coachConversation.update.mockResolvedValue({});
  txCreate.coachMessage.create.mockImplementation(
    async (arg: { data: { metricSourceJson: string | null } }) => ({
      id: "m1",
      role: "assistant",
      createdAt: new Date("2026-09-26T00:00:00.000Z"),
      metricSourceJson: overrideJson ?? arg.data.metricSourceJson,
      providerType: null,
      promptVersion: null,
      tokensUsed: null,
      model: null,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("appendMessage — the dialog fields", () => {
  it("restores steps, method, table metadata, chips, clarification, the forced marker and the continuation", async () => {
    stubEchoCreate();
    const out = await appendMessage({
      conversationId: "c1",
      role: "assistant",
      content: "reply",
      metricSource: FULL,
    });
    expect(out.metricSource).toEqual(FULL);
  });

  it("drops a malformed entry and keeps its well-formed siblings", async () => {
    stubEchoCreate(
      JSON.stringify({
        windows: [],
        metrics: [],
        steps: [FULL.steps![0], { id: "s2", status: "exploded" }],
        results: [{ ref: "r9" }, META],
        followUps: [{ ...FULL.followUps![0], kind: "free_text" }],
        method: { entries: "nope", text: "x" },
        clarification: { kind: "metric", choices: [], freeText: "yes" },
        forcedFinal: "true",
        continuationOf: 42,
      }),
    );
    const out = await appendMessage({
      conversationId: "c1",
      role: "assistant",
      content: "reply",
      metricSource: { windows: [], metrics: [] },
    });
    expect(out.metricSource).toEqual({
      windows: [],
      metrics: [],
      steps: FULL.steps,
      results: [META],
    });
  });

  it("reads a stored view chip back only where the answer's panel has no toggle for it", async () => {
    // Stored before the rule: "as a table" for the shown chart (r1), whose
    // panel already toggles, and "as a chart" for a table only used (r2).
    const view = (id: string, kind: "as_chart" | "as_table", ref: string) => ({
      ...FULL.followUps![0],
      id,
      kind,
      labelKey: `coach.followUp.${kind === "as_chart" ? "asChart" : "asTable"}`,
      label: kind === "as_chart" ? "Show as a chart" : "Show as a table",
      anchor: { ref, domain: "bp" as const, window: "last30days" as const },
      reuse: true,
    });
    const used = { ...SLEEP_META, displayed: false };
    stubEchoCreate(
      JSON.stringify({
        windows: [],
        metrics: [],
        results: [META, used],
        followUps: [
          view("f0", "as_table", "r1"),
          FULL.followUps![0],
          view("f3", "as_chart", "r2"),
        ],
      }),
    );
    const out = await appendMessage({
      conversationId: "c1",
      role: "assistant",
      content: "reply",
      metricSource: { windows: [], metrics: [] },
    });
    expect(out.metricSource?.followUps?.map((c) => [c.id, c.kind])).toEqual([
      ["f1", "previous_period"],
      ["f3", "as_chart"],
    ]);

    // Only the redundant chip stored: the list reads back absent, not empty.
    stubEchoCreate(
      JSON.stringify({
        windows: [],
        metrics: [],
        results: [META],
        followUps: [view("f1", "as_table", "r1")],
      }),
    );
    const bare = await appendMessage({
      conversationId: "c1",
      role: "assistant",
      content: "reply",
      metricSource: { windows: [], metrics: [] },
    });
    expect(bare.metricSource).not.toHaveProperty("followUps");
  });

  it("strips a key the stored blob carries that the contract does not know", async () => {
    stubEchoCreate(
      JSON.stringify({
        windows: [],
        metrics: [],
        results: [{ ...META, rows: [["2026-09-01", 128]] }],
      }),
    );
    const out = await appendMessage({
      conversationId: "c1",
      role: "assistant",
      content: "reply",
      metricSource: { windows: [], metrics: [] },
    });
    // Values never ride the plaintext provenance, even when a blob has them.
    expect(out.metricSource?.results?.[0]).not.toHaveProperty("rows");
  });
});

describe("appendMessage — the tables", () => {
  it("seals the tables into their own column and leaves them out of the provenance", async () => {
    stubEchoCreate();
    await appendMessage({
      conversationId: "c1",
      role: "assistant",
      content: "reply",
      metricSource: { windows: [], metrics: [], results: [META] },
      results: [TABLE],
    });
    const data = txCreate.coachMessage.create.mock.calls[0][0].data;
    expect(new TextDecoder().decode(data.resultsEncrypted)).toBe(
      `enc:${JSON.stringify([TABLE])}`,
    );
    expect(data.metricSourceJson).not.toContain("2026-09-01");
  });

  it("writes NULL on a turn without tables", async () => {
    stubEchoCreate();
    await appendMessage({
      conversationId: "c1",
      role: "assistant",
      content: "reply",
      results: [],
    });
    const data = txCreate.coachMessage.create.mock.calls[0][0].data;
    expect(data.resultsEncrypted).toBeNull();
  });

  it("drops whole tables from the end until the message fits the ceiling", async () => {
    stubEchoCreate();
    const big: CoachResultTable = {
      ...TABLE,
      ref: "r2",
      rows: Array.from({ length: 400 }, () => ["x".repeat(400), 1]),
    };
    await appendMessage({
      conversationId: "c1",
      role: "assistant",
      content: "reply",
      results: [TABLE, big],
    });
    const data = txCreate.coachMessage.create.mock.calls[0][0].data;
    const json = new TextDecoder().decode(data.resultsEncrypted).slice(4);
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(RESULTS_MAX_BYTES);
    expect(JSON.parse(json)).toEqual([TABLE]);
  });
});

describe("readMessageResults", () => {
  function row(results: CoachResultMeta[], bytes: Uint8Array | null) {
    return {
      metricSourceJson: JSON.stringify({ windows: [], metrics: [], results }),
      resultsEncrypted: bytes,
    };
  }
  const sealed = (tables: unknown) =>
    new TextEncoder().encode(`enc:${JSON.stringify(tables)}`);

  it("narrows to the owner through the conversation", async () => {
    findFirst.mockResolvedValue(null);
    await expect(readMessageResults("u1", "c1", "m1")).resolves.toBeNull();
    expect(findFirst.mock.calls[0][0].where).toEqual({
      id: "m1",
      conversationId: "c1",
      conversation: { userId: "u1" },
    });
  });

  it("serves every table the provenance lists, in its order", async () => {
    findFirst.mockResolvedValue(row([META], sealed([TABLE])));
    await expect(readMessageResults("u1", "c1", "m1")).resolves.toEqual([
      TABLE,
    ]);
  });

  it("withholds a table whose domain is switched off, without decrypting it", async () => {
    findFirst.mockResolvedValue(
      row([META, SLEEP_META], sealed([TABLE, { ...TABLE, ...SLEEP_META }])),
    );
    const out = await readMessageResults(
      "u1",
      "c1",
      "m1",
      (domain) => domain === "sleep",
    );
    expect(out).toEqual([TABLE, { ref: "r2", withheld: "module_disabled" }]);

    findFirst.mockResolvedValue(row([SLEEP_META], sealed([TABLE])));
    const { decryptFromBytes } = await import("../bytes-codec");
    vi.mocked(decryptFromBytes).mockClear();
    await readMessageResults("u1", "c1", "m1", () => true);
    expect(decryptFromBytes).not.toHaveBeenCalled();
  });

  it("names a table it cannot read rather than serving nothing", async () => {
    findFirst.mockResolvedValue(
      row([META], new TextEncoder().encode("garbage")),
    );
    await expect(readMessageResults("u1", "c1", "m1")).resolves.toEqual([
      { ref: "r1", withheld: "unavailable" },
    ]);

    // A ref the ciphertext does not carry (dropped at the size ceiling).
    findFirst.mockResolvedValue(row([META, SLEEP_META], sealed([TABLE])));
    await expect(readMessageResults("u1", "c1", "m1")).resolves.toEqual([
      TABLE,
      { ref: "r2", withheld: "unavailable" },
    ]);
  });

  it("answers an empty list for a message without tables", async () => {
    findFirst.mockResolvedValue({
      metricSourceJson: null,
      resultsEncrypted: null,
    });
    await expect(readMessageResults("u1", "c1", "m1")).resolves.toEqual([]);
  });
});
