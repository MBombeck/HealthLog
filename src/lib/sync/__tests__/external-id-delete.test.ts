import { describe, expect, it } from "vitest";

import {
  MAX_EXTERNAL_ID_DELETES,
  parseExternalIdDelete,
} from "../external-id-delete";

function req(body: unknown): Request {
  return new Request("http://localhost/api/workouts/by-external-ids", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function errorCode(res: Response): Promise<string | undefined> {
  const body = (await res.json()) as { meta?: { errorCode?: string } };
  return body.meta?.errorCode;
}

describe("parseExternalIdDelete", () => {
  it("returns the ids once each", async () => {
    const parsed = await parseExternalIdDelete(
      req({ externalIds: ["a", "b", "a"] }),
      "workout",
    );
    expect(parsed).toEqual({ ok: true, externalIds: ["a", "b"] });
  });

  it("accepts an empty list", async () => {
    expect(
      await parseExternalIdDelete(req({ externalIds: [] }), "workout"),
    ).toEqual({ ok: true, externalIds: [] });
  });

  it("refuses more than 500 ids with its own code", async () => {
    const ids = Array.from(
      { length: MAX_EXTERNAL_ID_DELETES + 1 },
      (_, i) => `id-${i}`,
    );
    const parsed = await parseExternalIdDelete(
      req({ externalIds: ids }),
      "workout",
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.status).toBe(422);
    expect(await errorCode(parsed.error)).toBe("workout.delete.too_large");
  });

  it("refuses a malformed body as invalid, naming the domain", async () => {
    for (const body of [
      {},
      { externalIds: "a" },
      { externalIds: [""] },
      { externalIds: ["x".repeat(121)] },
      { externalIds: ["a"], userId: "someone-else" },
    ]) {
      const parsed = await parseExternalIdDelete(req(body), "mood");
      expect(parsed.ok, JSON.stringify(body)).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.error.status).toBe(422);
      expect(await errorCode(parsed.error)).toBe("mood.delete.invalid");
    }
  });
});
