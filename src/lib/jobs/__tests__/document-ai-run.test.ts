/**
 * The background document AI run worker (v1.40).
 *
 * What only the worker decides, with every collaborator stubbed: a run is
 * claimed once; the capability is asked again for the record and the wire is
 * re-checked for the provider actually picked, so a switch turned off or a
 * consent withdrawn while the run waited stops it before anything leaves; the
 * deadline follows the person's AI response time and a read that cannot fit
 * the job's expiry is refused; and whatever ends the run settles the budget
 * exactly once.
 *
 * Mutation checks, run against this file: deleting the `aiEgressRefusal` call
 * in `assertRunMayEgress` turns "refuses when consent was withdrawn" red;
 * deleting the `aiCapabilityForJob` check turns "refuses when the operator
 * turned reading off" red; dropping the `ends > deadlineAt` comparison turns
 * "refuses a read that cannot fit" red. For the summary and suggest kinds:
 * deleting `afterRunFailed` (or its `markQueuedSummaryUnavailable` call)
 * turns "a stored summary that fails is marked UNAVAILABLE" red, and deleting
 * the `assertRunMayEgress` call in `pickForDocumentRead`'s text branch turns
 * "a text suggestion re-checks the wire" red.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const claimAiRun = vi.fn();
const completeAiRun = vi.fn();
const failAiRun = vi.fn();
const settleAiRunBudget = vi.fn();
vi.mock("@/lib/documents/ai-runs/store", () => ({
  claimAiRun: (...a: unknown[]) => claimAiRun(...a),
  completeAiRun: (...a: unknown[]) => completeAiRun(...a),
  failAiRun: (...a: unknown[]) => failAiRun(...a),
  settleAiRunBudget: (...a: unknown[]) => settleAiRunBudget(...a),
}));

const aiCapabilityForJob = vi.fn();
vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityForJob: (...a: unknown[]) => aiCapabilityForJob(...a),
}));
const aiEgressRefusal = vi.fn();
vi.mock("@/lib/ai/capabilities/egress", () => ({
  aiEgressRefusal: (...a: unknown[]) => aiEgressRefusal(...a),
}));

const requireDocumentVisionProvider = vi.fn();
const requireDocumentTextProvider = vi.fn();
vi.mock("@/lib/documents/provider-order", () => ({
  requireDocumentVisionProvider: (...a: unknown[]) =>
    requireDocumentVisionProvider(...a),
  requireDocumentTextProvider: (...a: unknown[]) =>
    requireDocumentTextProvider(...a),
}));
const requireLabsOcrProvider = vi.fn();
vi.mock("@/lib/labs/ocr-capability", () => ({
  requireLabsOcrProvider: (...a: unknown[]) => requireLabsOcrProvider(...a),
}));

const executeDocumentIndex = vi.fn();
vi.mock("@/lib/documents/ai-runs/index-run", () => ({
  DOCUMENT_INDEX_MODEL_CALLS: 3,
  executeDocumentIndex: (...a: unknown[]) => executeDocumentIndex(...a),
}));
const executeOcrExtraction = vi.fn();
vi.mock("@/lib/labs/ocr-run", () => ({
  OCR_EXTRACT_MODEL_CALLS: 2,
  executeOcrExtraction: (...a: unknown[]) => executeOcrExtraction(...a),
}));

const executeDocumentSummary = vi.fn();
const markQueuedSummaryUnavailable = vi.fn();
vi.mock("@/lib/documents/ai-runs/summary-run", () => ({
  DOCUMENT_SUMMARY_MODEL_CALLS: 1,
  executeDocumentSummary: (...a: unknown[]) => executeDocumentSummary(...a),
  markQueuedSummaryUnavailable: (...a: unknown[]) =>
    markQueuedSummaryUnavailable(...a),
}));
const executeDocumentSuggest = vi.fn();
vi.mock("@/lib/documents/ai-runs/suggest-run", () => ({
  DOCUMENT_SUGGEST_MODEL_CALLS: 1,
  executeDocumentSuggest: (...a: unknown[]) => executeDocumentSuggest(...a),
}));

const executeDocumentExtract = vi.fn();
vi.mock("@/lib/documents/ai-runs/extract-run", () => ({
  DOCUMENT_EXTRACT_MODEL_CALLS: 2,
  executeDocumentExtract: (...a: unknown[]) => executeDocumentExtract(...a),
}));
const loadDocumentChatText = vi.fn();
vi.mock("@/lib/documents/content-index", () => ({
  loadDocumentChatText: (...a: unknown[]) => loadDocumentChatText(...a),
}));

const loadOwnedDocument = vi.fn();
vi.mock("@/lib/documents/ai-route-support", () => ({
  loadOwnedDocument: (...a: unknown[]) => loadOwnedDocument(...a),
}));

const updateMany = vi.fn();
const findUser = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    documentAiRun: { updateMany: (...a: unknown[]) => updateMany(...a) },
    user: { findUnique: (...a: unknown[]) => findUser(...a) },
  },
}));

const send = vi.fn();
let boss: { send: typeof send } | null = { send };
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => boss,
}));

import { AiUnavailableError } from "@/lib/ai/capabilities/refusal";
import {
  DOCUMENT_AI_RUN_EXPIRE_SECONDS,
  enqueueDocumentAiRun,
  handleDocumentAiRunJobs,
  runDocumentAiRun,
} from "@/lib/jobs/document-ai-run";
import { DOCUMENT_AI_RUN_QUEUE } from "@/lib/jobs/document-ai-run-queue";

const NOW = 1_800_000_000_000;
const now = () => NOW;
const budget = { reserved: 4000, owner: "user", dateKey: "2027-01-15" };

function claimed(overrides: Record<string, unknown> = {}) {
  return {
    id: "run1",
    userId: "u1",
    kind: "DOCUMENT_INDEX",
    documentId: "d1",
    params: { mode: "vision", budget },
    input: null,
    ...overrides,
  };
}

const visionPick = (seconds: number | null) => ({
  entry: {
    providerType: "anthropic",
    instance: { responseTimeoutSeconds: seconds },
  },
  providerType: "anthropic",
  pdfSupported: true,
});

beforeEach(() => {
  vi.clearAllMocks();
  boss = { send };
  claimAiRun.mockResolvedValue(claimed());
  aiCapabilityForJob.mockResolvedValue({ available: true, reason: null });
  aiEgressRefusal.mockResolvedValue(null);
  requireDocumentVisionProvider.mockResolvedValue(visionPick(null));
  loadOwnedDocument.mockResolvedValue({ id: "d1" });
  executeDocumentIndex.mockResolvedValue({
    ok: true,
    data: { documentId: "d1", indexed: true, tokenCount: 3, labFactsStaged: 0 },
  });
  updateMany.mockResolvedValue({ count: 1 });
  completeAiRun.mockResolvedValue(true);
  failAiRun.mockResolvedValue(true);
});

describe("enqueueDocumentAiRun", () => {
  it("sends one run with its expiry and no retry", async () => {
    send.mockResolvedValue("job1");
    expect(await enqueueDocumentAiRun("run1", "u1")).toBe(true);
    expect(send).toHaveBeenCalledWith(
      DOCUMENT_AI_RUN_QUEUE,
      { runId: "run1", userId: "u1" },
      { retryLimit: 0, expireInSeconds: DOCUMENT_AI_RUN_EXPIRE_SECONDS },
    );
  });

  it("reports no queue as not enqueued", async () => {
    boss = null;
    expect(await enqueueDocumentAiRun("run1", "u1")).toBe(false);
  });

  it("reports a failed send as not enqueued", async () => {
    send.mockRejectedValue(new Error("db down"));
    expect(await enqueueDocumentAiRun("run1", "u1")).toBe(false);
  });
});

describe("runDocumentAiRun", () => {
  it("skips a run another delivery already claimed", async () => {
    claimAiRun.mockResolvedValue(null);
    expect(await runDocumentAiRun("run1", NOW + 2_700_000, now)).toBe(
      "skipped",
    );
    expect(executeDocumentIndex).not.toHaveBeenCalled();
  });

  it("reads, stores the result, and arms the deadline from the setting", async () => {
    requireDocumentVisionProvider.mockResolvedValue(visionPick(300));
    expect(await runDocumentAiRun("run1", NOW + 2_700_000, now)).toBe(
      "succeeded",
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "run1", status: "RUNNING" },
      data: { expiresAt: new Date(NOW + 3 * 300_000 + 60_000) },
    });
    expect(aiEgressRefusal).toHaveBeenCalledWith("documentAi", "u1", [
      "anthropic",
    ]);
    expect(completeAiRun).toHaveBeenCalledWith(
      "run1",
      { documentId: "d1", indexed: true, tokenCount: 3, labFactsStaged: 0 },
      new Date(NOW),
    );
    expect(settleAiRunBudget).not.toHaveBeenCalled();
  });

  it("refuses when the operator turned reading off while the run waited", async () => {
    aiCapabilityForJob.mockResolvedValue({
      available: false,
      reason: "operator_disabled",
    });
    expect(await runDocumentAiRun("run1", NOW + 2_700_000, now)).toBe("failed");
    expect(executeDocumentIndex).not.toHaveBeenCalled();
    expect(settleAiRunBudget).toHaveBeenCalledWith("u1", budget, 0, null);
    expect(failAiRun).toHaveBeenCalledWith(
      "run1",
      expect.objectContaining({
        status: 403,
        errorCode: "assistant.disabled.documentAi",
      }),
      "RUNNING",
      new Date(NOW),
    );
  });

  it("refuses when consent was withdrawn for the picked provider", async () => {
    aiEgressRefusal.mockResolvedValue(
      new AiUnavailableError("documentAi", "consent_required"),
    );
    expect(await runDocumentAiRun("run1", NOW + 2_700_000, now)).toBe("failed");
    expect(executeDocumentIndex).not.toHaveBeenCalled();
    expect(failAiRun).toHaveBeenCalledWith(
      "run1",
      expect.objectContaining({
        status: 403,
        errorCode: "consent.ai.required",
      }),
      "RUNNING",
      new Date(NOW),
    );
  });

  it("refuses a read that cannot fit the job's expiry", async () => {
    requireDocumentVisionProvider.mockResolvedValue(visionPick(600));
    // Three calls at ten minutes plus the margin do not fit in twenty minutes.
    expect(await runDocumentAiRun("run1", NOW + 20 * 60_000, now)).toBe(
      "failed",
    );
    expect(executeDocumentIndex).not.toHaveBeenCalled();
    expect(settleAiRunBudget).toHaveBeenCalledWith("u1", budget, 0, null);
    expect(failAiRun).toHaveBeenCalledWith(
      "run1",
      expect.objectContaining({ errorCode: "aiRuns.timedOut", status: 504 }),
      "RUNNING",
      new Date(NOW),
    );
  });

  it("stores the route's own failure when the read fails", async () => {
    executeDocumentIndex.mockResolvedValue({
      ok: false,
      status: 422,
      message: "Couldn't read the document. Try a clearer copy.",
      errorCode: "documents.inbound.extractFailed",
    });
    expect(await runDocumentAiRun("run1", NOW + 2_700_000, now)).toBe("failed");
    // The body settled its own reservation; the worker must not settle again.
    expect(settleAiRunBudget).not.toHaveBeenCalled();
    expect(failAiRun).toHaveBeenCalledWith(
      "run1",
      {
        status: 422,
        errorCode: "documents.inbound.extractFailed",
        message: "Couldn't read the document. Try a clearer copy.",
      },
      "RUNNING",
      new Date(NOW),
    );
  });

  it("fails a run whose document is gone and hands the reservation back", async () => {
    loadOwnedDocument.mockResolvedValue(null);
    expect(await runDocumentAiRun("run1", NOW + 2_700_000, now)).toBe("failed");
    expect(settleAiRunBudget).toHaveBeenCalledWith("u1", budget, 0, null);
    expect(failAiRun).toHaveBeenCalledWith(
      "run1",
      expect.objectContaining({ errorCode: "documents.inbound.notFound" }),
      "RUNNING",
      new Date(NOW),
    );
  });

  it("arms a text read for the lab staging that follows it", async () => {
    claimAiRun.mockResolvedValue(
      claimed({ params: { mode: "text" }, input: Buffer.from("Befund") }),
    );
    findUser.mockResolvedValue({ aiResponseTimeoutSeconds: 120 });
    expect(await runDocumentAiRun("run1", NOW + 2_700_000, now)).toBe(
      "succeeded",
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "run1", status: "RUNNING" },
      data: { expiresAt: new Date(NOW + 2 * 120_000 + 60_000) },
    });
    expect(executeDocumentIndex).toHaveBeenCalledWith(
      expect.objectContaining({ input: { mode: "text", text: "Befund" } }),
    );
    expect(aiEgressRefusal).not.toHaveBeenCalled();
  });

  it("reads a lab scan through the labs capability and its own provider", async () => {
    claimAiRun.mockResolvedValue(
      claimed({
        kind: "LABS_OCR_EXTRACT",
        documentId: null,
        params: { mode: "text", budget },
        input: Buffer.from("Hb 14 g/dL"),
      }),
    );
    requireLabsOcrProvider.mockResolvedValue({
      entry: {
        providerType: "openai",
        instance: { responseTimeoutSeconds: null },
      },
      providerType: "openai",
    });
    executeOcrExtraction.mockResolvedValue({
      ok: true,
      data: { reportDate: null, providerType: "openai", rows: [] },
    });
    expect(await runDocumentAiRun("run1", NOW + 2_700_000, now)).toBe(
      "succeeded",
    );
    expect(aiCapabilityForJob).toHaveBeenCalledWith("u1", "labsOcr");
    expect(aiEgressRefusal).toHaveBeenCalledWith("labsOcr", "u1", ["openai"]);
    expect(executeOcrExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ mode: "text", text: "Hb 14 g/dL" }),
      }),
    );
  });

  it("hands a lab scan a schedule that fits the deadline and moves it", async () => {
    claimAiRun.mockResolvedValue(
      claimed({
        kind: "LABS_OCR_EXTRACT",
        documentId: null,
        params: { mode: "vision", mime: "application/pdf", budget },
        input: Buffer.from("%PDF-1.4"),
      }),
    );
    requireLabsOcrProvider.mockResolvedValue({
      entry: {
        providerType: "anthropic",
        instance: { responseTimeoutSeconds: null },
      },
      providerType: "anthropic",
      pdfSupported: true,
    });
    executeOcrExtraction.mockImplementation(async (args) => {
      // 2 700 s of job budget, a 60 s margin and a second of slack, at the
      // read's own 120 s default per call: 21 sequential calls fit.
      expect(args.schedule.maxModelCalls()).toBe(21);
      await args.schedule.arm(20);
      return {
        ok: true,
        data: { reportDate: null, providerType: "anthropic", rows: [] },
      };
    });
    expect(await runDocumentAiRun("run1", NOW + 2_700_000, now)).toBe(
      "succeeded",
    );
    // One read armed first, then the twenty calls the read planned.
    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "run1", status: "RUNNING" },
      data: { expiresAt: new Date(NOW + 2 * 120_000 + 60_000) },
    });
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: "run1", status: "RUNNING" },
      data: { expiresAt: new Date(NOW + 20 * 120_000 + 60_000) },
    });
  });
});

describe("handleDocumentAiRunJobs", () => {
  it("runs each job under its own deadline and reports the counts", async () => {
    const outcome = await handleDocumentAiRunJobs([
      {
        id: "j1",
        data: { runId: "run1", userId: "u1" },
        expireInSeconds: DOCUMENT_AI_RUN_EXPIRE_SECONDS,
      },
      { id: "j2", data: { runId: "", userId: "u1" }, expireInSeconds: 60 },
    ] as never);
    expect(outcome).toMatchObject({
      ok: true,
      did: { jobs: 2, processed: 1, failed: 0, skipped: 1 },
    });
  });
});

describe("summary and suggestion runs", () => {
  const summaryRun = (overrides: Record<string, unknown> = {}) =>
    claimed({
      kind: "DOCUMENT_SUMMARY",
      params: {
        mode: "vision",
        budget,
        summary: {
          output: "summary",
          persist: true,
          replace: false,
          locale: "de",
        },
      },
      ...overrides,
    });

  beforeEach(() => {
    executeDocumentSummary.mockResolvedValue({
      ok: true,
      data: { summary: "Ein Arztbrief.", persistence: "stored" },
    });
    executeDocumentSuggest.mockResolvedValue({
      ok: true,
      data: {
        suggestions: { title: "Brief", kind: "OTHER", documentDate: null },
      },
    });
    requireDocumentTextProvider.mockResolvedValue({
      entry: {
        providerType: "local",
        instance: { responseTimeoutSeconds: 90 },
      },
      providerType: "local",
    });
  });

  it("reads a summary after the re-check, with one call's deadline and its options", async () => {
    claimAiRun.mockResolvedValue(summaryRun());
    requireDocumentVisionProvider.mockResolvedValue(visionPick(300));
    expect(await runDocumentAiRun("run1", NOW + 2_700_000, now)).toBe(
      "succeeded",
    );
    expect(aiCapabilityForJob).toHaveBeenCalledWith("u1", "documentAi");
    expect(aiEgressRefusal).toHaveBeenCalledWith("documentAi", "u1", [
      "anthropic",
    ]);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "run1", status: "RUNNING" },
      data: { expiresAt: new Date(NOW + 300_000 + 60_000) },
    });
    expect(executeDocumentSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ mode: "vision", budget }),
        output: "summary",
        locale: "de",
        persist: { replaceExisting: false },
        origin: { ipAddress: null, worker: true },
      }),
    );
    expect(completeAiRun).toHaveBeenCalledWith(
      "run1",
      { summary: "Ein Arztbrief.", persistence: "stored" },
      new Date(NOW),
    );
    expect(markQueuedSummaryUnavailable).not.toHaveBeenCalled();
  });

  it("refuses a summary when consent was withdrawn while it waited, and marks it UNAVAILABLE", async () => {
    claimAiRun.mockResolvedValue(summaryRun());
    aiEgressRefusal.mockResolvedValue(
      new AiUnavailableError("documentAi", "consent_required"),
    );
    expect(await runDocumentAiRun("run1", NOW + 2_700_000, now)).toBe("failed");
    expect(executeDocumentSummary).not.toHaveBeenCalled();
    expect(settleAiRunBudget).toHaveBeenCalledWith("u1", budget, 0, null);
    expect(markQueuedSummaryUnavailable).toHaveBeenCalledWith("u1", "d1");
  });

  it("a stored summary that fails is marked UNAVAILABLE", async () => {
    claimAiRun.mockResolvedValue(summaryRun());
    executeDocumentSummary.mockResolvedValue({
      ok: false,
      status: 502,
      message: "Couldn't read the document. Try a clearer copy.",
      errorCode: "documents.inbound.extractFailed",
    });
    expect(await runDocumentAiRun("run1", NOW + 2_700_000, now)).toBe("failed");
    expect(markQueuedSummaryUnavailable).toHaveBeenCalledWith("u1", "d1");
  });

  it("a stored summary that could not be written is marked UNAVAILABLE", async () => {
    claimAiRun.mockResolvedValue(summaryRun());
    executeDocumentSummary.mockResolvedValue({
      ok: true,
      data: { summary: "Ein Arztbrief.", persistence: "failed" },
    });
    expect(await runDocumentAiRun("run1", NOW + 2_700_000, now)).toBe(
      "succeeded",
    );
    expect(markQueuedSummaryUnavailable).toHaveBeenCalledWith("u1", "d1");
  });

  it("a transient summary that fails leaves the document's state alone", async () => {
    claimAiRun.mockResolvedValue(
      summaryRun({
        params: {
          mode: "vision",
          budget,
          summary: {
            output: "text",
            persist: false,
            replace: false,
            locale: "en",
          },
        },
      }),
    );
    executeDocumentSummary.mockResolvedValue({
      ok: false,
      status: 502,
      message: "Couldn't read the document. Try a clearer copy.",
      errorCode: "documents.inbound.extractFailed",
    });
    expect(await runDocumentAiRun("run1", NOW + 2_700_000, now)).toBe("failed");
    expect(markQueuedSummaryUnavailable).not.toHaveBeenCalled();
  });

  it("refuses a summary that cannot fit the job's expiry", async () => {
    claimAiRun.mockResolvedValue(summaryRun());
    requireDocumentVisionProvider.mockResolvedValue(visionPick(600));
    // One call at ten minutes plus the margin does not fit in ten minutes.
    expect(await runDocumentAiRun("run1", NOW + 10 * 60_000, now)).toBe(
      "failed",
    );
    expect(executeDocumentSummary).not.toHaveBeenCalled();
    expect(failAiRun).toHaveBeenCalledWith(
      "run1",
      expect.objectContaining({ errorCode: "aiRuns.timedOut", status: 504 }),
      "RUNNING",
      new Date(NOW),
    );
  });

  it("fails a summary whose document is gone, settling the reservation once", async () => {
    claimAiRun.mockResolvedValue(summaryRun());
    loadOwnedDocument.mockResolvedValue(null);
    expect(await runDocumentAiRun("run1", NOW + 2_700_000, now)).toBe("failed");
    expect(settleAiRunBudget).toHaveBeenCalledOnce();
    expect(failAiRun).toHaveBeenCalledWith(
      "run1",
      expect.objectContaining({
        status: 404,
        errorCode: "documents.inbound.notFound",
      }),
      "RUNNING",
      new Date(NOW),
    );
  });

  it("a text suggestion re-checks the wire for the text provider and reads the sealed text", async () => {
    claimAiRun.mockResolvedValue(
      claimed({
        kind: "DOCUMENT_SUGGEST",
        params: { mode: "text", budget },
        input: Buffer.from("Arbeitsunfähigkeitsbescheinigung"),
      }),
    );
    expect(await runDocumentAiRun("run1", NOW + 2_700_000, now)).toBe(
      "succeeded",
    );
    expect(aiEgressRefusal).toHaveBeenCalledWith("documentAi", "u1", ["local"]);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "run1", status: "RUNNING" },
      data: { expiresAt: new Date(NOW + 90_000 + 60_000) },
    });
    expect(executeDocumentSuggest).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          mode: "text",
          text: "Arbeitsunfähigkeitsbescheinigung",
        }),
      }),
    );
  });

  it("refuses a suggestion when the operator turned reading off", async () => {
    claimAiRun.mockResolvedValue(
      claimed({ kind: "DOCUMENT_SUGGEST", params: { mode: "vision", budget } }),
    );
    aiCapabilityForJob.mockResolvedValue({
      available: false,
      reason: "operator_disabled",
    });
    expect(await runDocumentAiRun("run1", NOW + 2_700_000, now)).toBe("failed");
    expect(executeDocumentSuggest).not.toHaveBeenCalled();
    expect(markQueuedSummaryUnavailable).not.toHaveBeenCalled();
  });
});

describe("extract runs", () => {
  const extractRun = (input: "stored" | "vision" | "text") =>
    claimed({
      kind: "DOCUMENT_EXTRACT",
      params: {
        mode: input === "vision" ? "vision" : "text",
        budget,
        extract: { input },
      },
      input: input === "text" ? Buffer.from("Hb 14 g/dL") : null,
    });

  beforeEach(() => {
    executeDocumentExtract.mockResolvedValue({
      ok: true,
      data: {
        document: {
          id: "d1",
          status: "EXTRACTED",
          facts: [{ id: "f1" }, { id: "f2" }],
        },
        incomplete: false,
      },
    });
    loadDocumentChatText.mockResolvedValue({ text: "Hb 14 g/dL" });
    requireDocumentTextProvider.mockResolvedValue({
      entry: {
        providerType: "local",
        instance: { responseTimeoutSeconds: 100 },
      },
      providerType: "local",
    });
  });

  it("stores only the count and the status, with two calls' deadline", async () => {
    claimAiRun.mockResolvedValue(extractRun("vision"));
    requireDocumentVisionProvider.mockResolvedValue(visionPick(300));
    expect(await runDocumentAiRun("run1", NOW + 2_700_000, now)).toBe(
      "succeeded",
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "run1", status: "RUNNING" },
      data: { expiresAt: new Date(NOW + 2 * 300_000 + 60_000) },
    });
    expect(completeAiRun).toHaveBeenCalledWith(
      "run1",
      { documentId: "d1", factsStaged: 2, status: "EXTRACTED" },
      new Date(NOW),
    );
  });

  it("says so when part of the document may be missing from the staged facts", async () => {
    claimAiRun.mockResolvedValue(extractRun("stored"));
    executeDocumentExtract.mockResolvedValue({
      ok: true,
      data: {
        document: { id: "d1", status: "EXTRACTED", facts: [{ id: "f1" }] },
        incomplete: true,
      },
    });
    expect(await runDocumentAiRun("run1", NOW + 2_700_000, now)).toBe(
      "succeeded",
    );
    expect(completeAiRun).toHaveBeenCalledWith(
      "run1",
      {
        documentId: "d1",
        factsStaged: 1,
        status: "EXTRACTED",
        incomplete: true,
      },
      new Date(NOW),
    );
  });

  it("hands an extract the lab scan's schedule: the read's own timeout per call, moved as it plans", async () => {
    claimAiRun.mockResolvedValue(extractRun("stored"));
    requireDocumentTextProvider.mockResolvedValue({
      entry: {
        providerType: "local",
        instance: { responseTimeoutSeconds: null },
      },
      providerType: "local",
    });
    executeDocumentExtract.mockImplementation(async (args) => {
      // As for a lab scan: 2 700 s of job budget, a 60 s margin and a second
      // of slack, at the read's own 120 s per call.
      expect(args.schedule.maxModelCalls()).toBe(21);
      await args.schedule.arm(12);
      return {
        ok: true,
        data: {
          document: { id: "d1", status: "EXTRACTED", facts: [] },
          incomplete: false,
        },
      };
    });
    expect(await runDocumentAiRun("run1", NOW + 2_700_000, now)).toBe(
      "succeeded",
    );
    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "run1", status: "RUNNING" },
      data: { expiresAt: new Date(NOW + 2 * 120_000 + 60_000) },
    });
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: "run1", status: "RUNNING" },
      data: { expiresAt: new Date(NOW + 12 * 120_000 + 60_000) },
    });
  });

  it("reads the stored text for a stored extract and re-checks the text provider's wire", async () => {
    claimAiRun.mockResolvedValue(extractRun("stored"));
    expect(await runDocumentAiRun("run1", NOW + 2_700_000, now)).toBe(
      "succeeded",
    );
    expect(loadDocumentChatText).toHaveBeenCalledWith("u1", "d1");
    expect(aiEgressRefusal).toHaveBeenCalledWith("documentAi", "u1", ["local"]);
    expect(executeDocumentExtract).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ mode: "stored", text: "Hb 14 g/dL" }),
      }),
    );
  });

  it("fails a stored extract whose text is gone, before any provider pick", async () => {
    claimAiRun.mockResolvedValue(extractRun("stored"));
    loadDocumentChatText.mockResolvedValue(null);
    expect(await runDocumentAiRun("run1", NOW + 2_700_000, now)).toBe("failed");
    expect(requireDocumentTextProvider).not.toHaveBeenCalled();
    expect(executeDocumentExtract).not.toHaveBeenCalled();
    expect(settleAiRunBudget).toHaveBeenCalledOnce();
    expect(failAiRun).toHaveBeenCalledWith(
      "run1",
      expect.objectContaining({
        status: 422,
        errorCode: "documents.inbound.notIndexed",
      }),
      "RUNNING",
      new Date(NOW),
    );
  });

  it("stores the staging refusal when a review finished while the read ran", async () => {
    claimAiRun.mockResolvedValue(extractRun("text"));
    executeDocumentExtract.mockResolvedValue({
      ok: false,
      status: 409,
      message: "Some facts from this document are already confirmed.",
      errorCode: "documents.inbound.alreadyPartlyConfirmed",
    });
    expect(await runDocumentAiRun("run1", NOW + 2_700_000, now)).toBe("failed");
    expect(executeDocumentExtract).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ mode: "text", text: "Hb 14 g/dL" }),
      }),
    );
    expect(failAiRun).toHaveBeenCalledWith(
      "run1",
      expect.objectContaining({
        status: 409,
        errorCode: "documents.inbound.alreadyPartlyConfirmed",
      }),
      "RUNNING",
      new Date(NOW),
    );
  });
});
