/**
 * Deleting an address-book entry is a soft delete with a restore route, and
 * nothing on the web offered it: a mistaken delete could not be taken back.
 * The delete now confirms with an Undo that calls the restore.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MutationObserver, QueryClient } from "@tanstack/react-query";

const toastSuccess = vi.hoisted(() => vi.fn());
const errorToast = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { success: toastSuccess } }));
vi.mock("@/lib/errors/error-toast", () => ({ showErrorToast: errorToast }));

import { deleteWithUndo } from "../practitioner-list";

type Mutations = Parameters<typeof deleteWithUndo>[0];

const t = (key: string) => key;

function mutations(restoreResult: () => Promise<unknown>) {
  const remove = { mutateAsync: vi.fn(async () => ({ deleted: true })) };
  const restore = { mutateAsync: vi.fn(restoreResult) };
  return { remove, restore, all: { remove, restore } as unknown as Mutations };
}

beforeEach(() => {
  toastSuccess.mockReset();
  errorToast.mockReset();
});

describe("deleteWithUndo", () => {
  it("confirms the delete with an Undo that restores the entry", async () => {
    const m = mutations(async () => ({ id: "p1" }));

    deleteWithUndo(m.all, "p1", t);

    expect(m.remove.mutateAsync).toHaveBeenCalledWith("p1");
    await vi.waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const [message, options] = toastSuccess.mock.calls[0]!;
    expect(message).toBe("practitioners.deleted");
    expect(options.action.label).toBe("common.undo");
    options.action.onClick();
    expect(m.restore.mutateAsync).toHaveBeenCalledWith("p1");
    await Promise.resolve();
    expect(errorToast).not.toHaveBeenCalled();
  });

  it("says so when the restore fails", async () => {
    const m = mutations(async () => {
      throw new Error("offline");
    });

    deleteWithUndo(m.all, "p1", t);
    await vi.waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    toastSuccess.mock.calls[0]![1].action.onClick();

    await vi.waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith(
        "practitioners.restoreFailed",
        expect.anything(),
      ),
    );
  });

  it("offers an Undo for each of two quick deletes", async () => {
    // One mutation observer for the list, as `useMutation` keeps it: the
    // callbacks of an earlier `mutate` are dropped once a later one starts.
    const observer = new MutationObserver(new QueryClient(), {
      mutationFn: async (id: string) => ({ id }),
    });
    const remove = {
      mutate: (id: string, options?: object) =>
        void observer.mutate(id, options).catch(() => undefined),
      mutateAsync: (id: string) => observer.mutate(id),
    };
    const restore = { mutateAsync: vi.fn(async () => ({})) };
    const all = { remove, restore } as unknown as Mutations;

    deleteWithUndo(all, "p1", t);
    deleteWithUndo(all, "p2", t);

    await vi.waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(2));
    for (const call of toastSuccess.mock.calls) call[1].action.onClick();
    expect(restore.mutateAsync.mock.calls).toEqual([["p1"], ["p2"]]);
  });
});
