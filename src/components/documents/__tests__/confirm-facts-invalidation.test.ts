/**
 * Confirming a document's facts creates medications, conditions and lab
 * values. The confirm used to evict only the roots of those lists, so the
 * dashboard, the Today digest, adherence, nutrients, the day and the timeline
 * kept showing the record without them.
 */
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";

import { invalidateConfirmedFactReads } from "../use-document-facts";
import { queryKeys } from "@/lib/query-keys";

const client = new QueryClient();

afterEach(() => client.clear());

describe("invalidateConfirmedFactReads", () => {
  it.each([
    ["the dashboard snapshot", queryKeys.dashboardSnapshot()],
    ["the Today digest", queryKeys.dailyDigest()],
    ["the nutrient reads", queryKeys.nutrientsRoot()],
    ["an open day", queryKeys.day("2026-11-10")],
    ["the timeline", queryKeys.timelineRoot()],
    ["the lab results", queryKeys.labResults()],
    ["the condition journal", queryKeys.illness()],
    ["the document", queryKeys.inboundDocument("doc-1")],
  ])("marks %s stale", async (_label, key) => {
    client.setQueryData(key, { seeded: true });

    await invalidateConfirmedFactReads(client, "doc-1");

    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  });
});
