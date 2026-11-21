/**
 * Every key on `GET /api/version` `features` is a documented constant from
 * `server-features.ts`, and the route publishes exactly that list.
 */
import { describe, expect, it } from "vitest";

import { SERVER_FEATURES, SERVER_FEATURE_DOCS } from "../server-features";
import { GET } from "@/app/api/version/route";

describe("server features", () => {
  it("keys are unique, dotted and lower case", () => {
    expect(new Set(SERVER_FEATURES).size).toBe(SERVER_FEATURES.length);
    for (const key of SERVER_FEATURES) {
      expect(key).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
    }
  });

  it("every key is documented, and every document has its key", () => {
    expect(Object.keys(SERVER_FEATURE_DOCS).sort()).toEqual(
      [...SERVER_FEATURES].sort(),
    );
    for (const key of SERVER_FEATURES) {
      expect(SERVER_FEATURE_DOCS[key].length).toBeGreaterThan(10);
    }
  });

  it("GET /api/version publishes exactly the list", async () => {
    const res = await (GET as unknown as () => Promise<Response>)();
    const body = (await res.json()) as { data: { features: string[] } };
    expect(body.data.features).toEqual([...SERVER_FEATURES]);
  });
});
