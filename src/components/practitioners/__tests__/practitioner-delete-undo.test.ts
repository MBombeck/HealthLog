/**
 * Deleting an address-book entry is a soft delete with a restore route, and
 * nothing on the web offered it: a mistaken delete could not be taken back.
 * The delete now confirms with an Undo that calls the restore.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const toastSuccess = vi.hoisted(() => vi.fn());
const errorToast = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { success: toastSuccess } }));
vi.mock("@/lib/errors/error-toast", () => ({ showErrorToast: errorToast }));

import { deleteWithUndo } from "../practitioner-list";

type Mutations = Parameters<typeof deleteWithUndo>[0];

const t = (key: string) => key;

function mutations(restoreResult: Promise<unknown>) {
  const remove = {
    mutate: vi.fn((_id: string, options: { onSuccess?: () => void }) =>
      options.onSuccess?.(),
    ),
  };
  const restore = { mutateAsync: vi.fn(() => restoreResult) };
  return { remove, restore, all: { remove, restore } as unknown as Mutations };
}

beforeEach(() => {
  toastSuccess.mockReset();
  errorToast.mockReset();
});

describe("deleteWithUndo", () => {
  it("confirms the delete with an Undo that restores the entry", async () => {
    const m = mutations(Promise.resolve({ id: "p1" }));

    deleteWithUndo(m.all, "p1", t);

    expect(m.remove.mutate).toHaveBeenCalledWith("p1", expect.anything());
    const [message, options] = toastSuccess.mock.calls[0]!;
    expect(message).toBe("practitioners.deleted");
    expect(options.action.label).toBe("common.undo");
    options.action.onClick();
    expect(m.restore.mutateAsync).toHaveBeenCalledWith("p1");
    await Promise.resolve();
    expect(errorToast).not.toHaveBeenCalled();
  });

  it("says so when the restore fails", async () => {
    const m = mutations(Promise.reject(new Error("offline")));

    deleteWithUndo(m.all, "p1", t);
    toastSuccess.mock.calls[0]![1].action.onClick();

    await vi.waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith(
        "practitioners.restoreFailed",
        expect.anything(),
      ),
    );
  });
});
