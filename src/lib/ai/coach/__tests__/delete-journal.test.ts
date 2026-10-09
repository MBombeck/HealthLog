import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearCoachDeleteJournal,
  coachDeleteJournalOwner,
  readCoachDeleteJournal,
  resendCoachDeleteJournal,
  writeCoachDeleteJournal,
} from "../delete-journal";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  };
}

const KEY = "healthlog:coach-conversation-deletes";
let storage: Storage;

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal("window", { sessionStorage: storage });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const alice = coachDeleteJournalOwner("user-a", null);
const aliceInManaged = coachDeleteJournalOwner("user-a", "managed-1");
const bob = coachDeleteJournalOwner("user-b", null);

describe("Coach delete journal", () => {
  it("binds each entry to the account and the record it was sent for", () => {
    writeCoachDeleteJournal(alice, "c1", true);
    writeCoachDeleteJournal(aliceInManaged, "c2", true);
    expect(readCoachDeleteJournal(alice)).toEqual(["c1"]);
    expect(readCoachDeleteJournal(aliceInManaged)).toEqual(["c2"]);
    expect(readCoachDeleteJournal(bob)).toEqual([]);

    writeCoachDeleteJournal(alice, "c1", false);
    expect(readCoachDeleteJournal(alice)).toEqual([]);
    expect(readCoachDeleteJournal(aliceInManaged)).toEqual(["c2"]);
  });

  it("re-sends nothing after a logout and another login in the same tab", () => {
    writeCoachDeleteJournal(alice, "c1", true);
    const commit = vi.fn();
    resendCoachDeleteJournal(bob, commit);
    expect(commit).not.toHaveBeenCalled();
    // The entry waits for its own scope instead of being spent on the wrong
    // one, where a 404 would have read as "already gone".
    expect(readCoachDeleteJournal(alice)).toEqual(["c1"]);
  });

  it("re-sends nothing outside the record after a switch into a managed profile", () => {
    writeCoachDeleteJournal(alice, "own-1", true);
    writeCoachDeleteJournal(aliceInManaged, "managed-c", true);

    const inManaged = vi.fn();
    resendCoachDeleteJournal(aliceInManaged, inManaged);
    expect(inManaged.mock.calls).toEqual([["managed-c"]]);

    const backHome = vi.fn();
    resendCoachDeleteJournal(alice, backHome);
    expect(backHome.mock.calls).toEqual([["own-1"]]);
  });

  it("drops entries without an owner instead of re-sending them anywhere", () => {
    storage.setItem(KEY, JSON.stringify(["legacy-id"]));
    const commit = vi.fn();
    resendCoachDeleteJournal(alice, commit);
    expect(commit).not.toHaveBeenCalled();
  });

  it("is emptied by a session end, whoever the entries belonged to", () => {
    writeCoachDeleteJournal(alice, "c1", true);
    writeCoachDeleteJournal(bob, "c2", true);
    clearCoachDeleteJournal();
    expect(storage.getItem(KEY)).toBeNull();
  });

  it("stays quiet without storage", () => {
    vi.stubGlobal("window", undefined);
    expect(() => writeCoachDeleteJournal(alice, "c1", true)).not.toThrow();
    expect(readCoachDeleteJournal(alice)).toEqual([]);
    expect(() => clearCoachDeleteJournal()).not.toThrow();
  });
});
