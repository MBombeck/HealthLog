import { fenceUserText } from "@/lib/ai/coach/data-fence";
import { coachReadOutput } from "./output-shapes";
import { runCoachTool } from "./shared";
import { READ_ONLY_ANNOTATIONS, type McpToolDefinition } from "./types";

function withoutSymptoms(
  illness: Record<string, unknown>,
): Record<string, unknown> {
  const rest = { ...illness };
  delete rest.symptoms;
  return rest;
}

/**
 * Fence the condition body sites in a `get_illness_recovery` result (v1.39.2).
 *
 * The Coach reads the same illness block inside its fenced snapshot, where the
 * sanitised site is enough. An MCP client gets the block as a bare tool result,
 * so the site, which is the person's own words, is wrapped like every other
 * free-text leaf this server returns. Nothing else in the result changes.
 */
function fenceIllnessSites(result: unknown): unknown {
  const r = result as {
    data?: { illness?: Record<string, unknown> } & Record<string, unknown>;
  };
  const illness = r?.data?.illness;
  if (!illness) return result;
  const fence = (list: unknown) =>
    Array.isArray(list)
      ? list.map((entry: Record<string, unknown>) =>
          typeof entry?.bodySite === "string"
            ? { ...entry, bodySite: fenceUserText(entry.bodySite) }
            : entry,
        )
      : list;
  return {
    ...r,
    data: {
      ...r.data,
      illness: {
        // The person's own symptom names (v1.40) are Coach-only this release:
        // the MCP surface does not carry them, so the block goes out without.
        ...withoutSymptoms(illness),
        active: fence(illness.active),
        recentResolved: fence(illness.recentResolved),
      },
    },
  };
}

export const getIllnessRecoveryTool: McpToolDefinition = {
  name: "get_illness_recovery",
  title: "Get illness & recovery",
  description:
    "Fetch the user's illness + recovery context: rest mode, active and recently-resolved illnesses (with the body site and side when the user named one), the recovery / strain composites, and the illness retrospective (recovery-gap, nadir, red flags). Carries the rest-mode safety flag for framing. Returns { present: false } when there is nothing to report.",
  inputShape: {},
  annotations: READ_ONLY_ANNOTATIONS,
  outputShape: coachReadOutput,
  async run(ctx, args) {
    return fenceIllnessSites(
      await runCoachTool(ctx, "get_illness_recovery", args),
    );
  },
};
