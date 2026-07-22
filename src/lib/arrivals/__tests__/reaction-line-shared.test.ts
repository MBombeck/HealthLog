import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(),
}));

const { getGlobalBoss } = await import("@/lib/jobs/boss-instance");
const { enqueueReactionLine } = await import("../reaction-line-shared");

const send: Mock<
  (
    queue: string,
    job: unknown,
    options?: { singletonKey?: string },
  ) => Promise<string>
> = vi.fn(async () => "job-id");

beforeEach(() => {
  send.mockClear();
  vi.mocked(getGlobalBoss).mockReturnValue({ send } as never);
});

describe("enqueueReactionLine", () => {
  it("uses a distinct singleton key for each marker revision", async () => {
    const base = {
      userId: "user-1",
      kind: "weight" as const,
      localDate: "2026-07-14",
    };

    await enqueueReactionLine({
      ...base,
      revision: "2026-07-14T06:00:00.000Z",
    });
    await enqueueReactionLine({
      ...base,
      revision: "2026-07-14T18:00:00.000Z",
    });

    const firstOptions = send.mock.calls[0]?.[2];
    const secondOptions = send.mock.calls[1]?.[2];
    expect(firstOptions?.singletonKey).not.toBe(secondOptions?.singletonKey);
    expect(secondOptions?.singletonKey).toContain("2026-07-14T18:00:00.000Z");
  });
});
