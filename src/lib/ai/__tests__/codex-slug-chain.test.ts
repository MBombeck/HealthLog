/**
 * The order a Codex sign-in walks, built from the operator's choice, our
 * preference order and the models the account is offered; and the vision
 * answer the gates read from it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const annotate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logging/context", () => ({ annotate }));

import {
  parseCodexModelList,
  type CodexCatalogRead,
  type CodexOfferedModel,
} from "../codex-model-catalog";
import {
  DEFAULT_SLUG_FALLBACK_CHAIN,
  buildCodexSlugChain,
  chainEntryReadsImages,
  codexSignInReadsImages,
  loadCodexAttemptChain,
  resolveCodexVisionSlug,
} from "../codex-slug-chain";
import {
  clearCodexSlugCache,
  codexCredentialKey,
  forgetCodexSignIn,
  rememberRejectedCodexSlug,
  setCachedCodexSlug,
  setCodexCatalogState,
  startCodexSignIn,
} from "../codex-slug-cache";

const OFFERED = parseCodexModelList(
  JSON.parse(
    readFileSync(
      join(__dirname, "fixtures/codex/models-response.json"),
      "utf8",
    ),
  ),
)!;

function offered(...slugs: string[]): CodexOfferedModel[] {
  return slugs.map((slug, i) => ({
    slug,
    listed: true,
    priority: i,
    inputModalities: ["text", "image"],
    specialty: null,
  }));
}

const ENV_KEYS = ["CODEX_MODEL", "CODEX_MODEL_FALLBACK_CHAIN"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  clearCodexSlugCache();
  annotate.mockReset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("buildCodexSlugChain", () => {
  it("without a list, walks the static preference order", () => {
    for (const list of [null, []]) {
      expect(buildCodexSlugChain({ offered: list })).toEqual({
        chain: [...DEFAULT_SLUG_FALLBACK_CHAIN],
        source: "static",
      });
    }
  });

  it("with the live list: preference order kept to what is offered, then the rest, then the static tail", () => {
    const { chain, source } = buildCodexSlugChain({ offered: OFFERED });
    expect(source).toBe("live");
    expect(chain).toEqual([
      // Our preference order, kept to what the account is offered.
      "gpt-5.6-terra",
      "gpt-6-sol",
      "gpt-6.1-sol",
      "gpt-6-luna",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      // Not offered (retired): only reached when everything above failed.
      "gpt-5.5",
    ]);
    // Never offered to the walk: the frontier tier, the hidden review model,
    // the hidden specialist line.
    for (const skipped of [
      "gpt-6-astra",
      "codex-auto-review",
      "gpt-daybreak-blue-latest",
    ]) {
      expect(chain).not.toContain(skipped);
    }
  });

  it("follows an account onto a model our order does not know yet, in the list's priority order", () => {
    // A later retirement: the gpt-5.6 line gone, two new models offered.
    const list: CodexOfferedModel[] = [
      { ...offered("gpt-7-luna")[0], priority: 9 },
      { ...offered("gpt-7-sol")[0], priority: 2 },
      { ...offered("gpt-6-luna")[0], priority: 5 },
      { ...offered("gpt-7-astra")[0], priority: 1 },
      { ...offered("gpt-7-mystery")[0], priority: null },
    ];
    expect(buildCodexSlugChain({ offered: list }).chain).toEqual([
      "gpt-6-luna",
      "gpt-7-sol",
      "gpt-7-luna",
      "gpt-7-mystery",
      // the static tail
      "gpt-5.6-terra",
      "gpt-6-sol",
      "gpt-6.1-sol",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.5",
    ]);
  });

  it("does not filter on supported_in_api, which describes API-key access", () => {
    const model = parseCodexModelList({
      models: [
        { slug: "gpt-7-sol", visibility: "list", supported_in_api: false },
      ],
    })!;
    expect(buildCodexSlugChain({ offered: model }).chain[0]).toBe("gpt-7-sol");
  });

  it("CODEX_MODEL goes first, ahead of the live order", () => {
    process.env.CODEX_MODEL = "gpt-6-astra";
    const { chain, source } = buildCodexSlugChain({ offered: OFFERED });
    expect(source).toBe("live");
    expect(chain[0]).toBe("gpt-6-astra");
    expect(chain[1]).toBe("gpt-5.6-terra");
    expect(new Set(chain).size).toBe(chain.length);
  });

  it("CODEX_MODEL_FALLBACK_CHAIN replaces the order outright and the list is ignored", () => {
    process.env.CODEX_MODEL = "pinned";
    process.env.CODEX_MODEL_FALLBACK_CHAIN = " a , b,,pinned ";
    expect(buildCodexSlugChain({ offered: OFFERED })).toEqual({
      chain: ["pinned", "a", "b"],
      source: "operator",
    });
  });

  it("an empty CODEX_MODEL_FALLBACK_CHAIN does not replace anything", () => {
    process.env.CODEX_MODEL_FALLBACK_CHAIN = " , ";
    expect(buildCodexSlugChain({ offered: null }).chain).toEqual([
      ...DEFAULT_SLUG_FALLBACK_CHAIN,
    ]);
  });

  it("moves slugs this sign-in was refused to the very end, never out", () => {
    const { chain } = buildCodexSlugChain({
      offered: OFFERED,
      rejected: new Set(["gpt-5.6-terra", "gpt-6-sol"]),
    });
    expect(chain.slice(0, 2)).toEqual(["gpt-6.1-sol", "gpt-6-luna"]);
    expect(chain.slice(-2)).toEqual(["gpt-5.6-terra", "gpt-6-sol"]);
  });
});

describe("loadCodexAttemptChain", () => {
  const credential = { key: codexCredentialKey.user("u1"), accountId: "acct" };

  it("reads the list for the sign-in and annotates the outcome", async () => {
    const readModels = vi.fn(async (): Promise<CodexCatalogRead> => ({
      models: offered("gpt-6.1-sol"),
      from: "live",
      failure: null,
    }));
    const chain = await loadCodexAttemptChain({
      credential,
      accessToken: "tok",
      readModels,
    });
    expect(chain[0]).toBe("gpt-6.1-sol");
    expect(readModels).toHaveBeenCalledWith(credential, {
      accessToken: "tok",
      accountId: "acct",
    });
    expect(annotate).toHaveBeenCalledWith({
      meta: {
        "codex.models.chain": "live",
        "codex.models.read": "live",
        "codex.models.failure": null,
        "codex.models.offered": 1,
      },
    });
  });

  it("falls back to the static walk when the read fails, or throws", async () => {
    const failing = vi.fn(async (): Promise<CodexCatalogRead> => ({
      models: null,
      from: "live",
      failure: "timeout",
    }));
    expect(
      await loadCodexAttemptChain({
        credential,
        accessToken: "t",
        readModels: failing,
      }),
    ).toEqual([...DEFAULT_SLUG_FALLBACK_CHAIN]);
    expect(annotate.mock.calls[0][0].meta).toEqual({
      "codex.models.chain": "static",
      "codex.models.read": "live",
      "codex.models.failure": "timeout",
      "codex.models.offered": 0,
    });

    const throwing = vi.fn(async (): Promise<CodexCatalogRead> => {
      throw new Error("bug");
    });
    expect(
      await loadCodexAttemptChain({
        credential,
        accessToken: "t",
        readModels: throwing,
      }),
    ).toEqual([...DEFAULT_SLUG_FALLBACK_CHAIN]);
  });

  it("does not read the list when the operator replaced the chain", async () => {
    process.env.CODEX_MODEL_FALLBACK_CHAIN = "x,y";
    const readModels = vi.fn();
    expect(
      await loadCodexAttemptChain({ credential, accessToken: "t", readModels }),
    ).toEqual(["x", "y"]);
    expect(readModels).not.toHaveBeenCalled();
    expect(annotate.mock.calls[0][0].meta["codex.models.read"]).toBe("skipped");
  });
});

describe("vision for a Codex sign-in", () => {
  const A = { key: codexCredentialKey.user("a"), accountId: "acct-a" };
  const B = { key: codexCredentialKey.user("b"), accountId: "acct-b" };

  it("reads the sign-in's own working slug, else the head of its own order", () => {
    setCodexCatalogState(B, {
      kind: "offered",
      models: offered("gpt-6-luna"),
      at: Date.now(),
    });
    setCachedCodexSlug(A, "gpt-6.1-sol");
    expect(resolveCodexVisionSlug(A.key)).toBe("gpt-6.1-sol");
    expect(resolveCodexVisionSlug(B.key)).toBe("gpt-6-luna");
    expect(resolveCodexVisionSlug(codexCredentialKey.central)).toBe(
      "gpt-5.6-terra",
    );
  });

  it("takes the list's input modalities over the model family", () => {
    // A family the gates know as vision-capable, listed as text-only.
    setCodexCatalogState(A, {
      kind: "offered",
      models: [{ ...offered("gpt-6-sol")[0], inputModalities: ["text"] }],
      at: Date.now(),
    });
    expect(codexSignInReadsImages(A.key)).toBe(false);

    // A text-only family by name, listed with image input.
    setCodexCatalogState(B, {
      kind: "offered",
      models: offered("o3-mini"),
      at: Date.now(),
    });
    expect(codexSignInReadsImages(B.key)).toBe(true);
  });

  it("answers from the new sign-in as soon as the credential is connected to another account", () => {
    // The old account: its working model listed as text-only.
    setCodexCatalogState(A, {
      kind: "offered",
      models: [{ ...offered("gpt-6-sol")[0], inputModalities: ["text"] }],
      at: Date.now(),
    });
    setCachedCodexSlug(A, "gpt-6-sol");
    expect(codexSignInReadsImages(A.key)).toBe(false);

    // What the device-poll route records on a reconnect.
    startCodexSignIn({ key: A.key, accountId: "acct-new" });
    expect(resolveCodexVisionSlug(A.key)).toBe(DEFAULT_SLUG_FALLBACK_CHAIN[0]);
    expect(codexSignInReadsImages(A.key)).toBe(true);
    expect(chainEntryReadsImages("codex", "a", null)).toBe(true);

    // And on a disconnect.
    setCachedCodexSlug(B, "o3-mini");
    expect(codexSignInReadsImages(B.key)).toBe(false);
    forgetCodexSignIn(B.key);
    expect(codexSignInReadsImages(B.key)).toBe(true);
  });

  it("falls back to the model family when the list says nothing", () => {
    setCodexCatalogState(A, {
      kind: "offered",
      // A text-only family the gates know, listed without modalities.
      models: [{ ...offered("o3-mini")[0], inputModalities: null }],
      at: Date.now(),
    });
    expect(codexSignInReadsImages(A.key)).toBe(false);
    // No list at all: the static head, a known vision family.
    expect(codexSignInReadsImages(B.key)).toBe(true);
  });

  it("skips a refused slug for the vision answer too", () => {
    rememberRejectedCodexSlug(A, "gpt-5.6-terra");
    expect(resolveCodexVisionSlug(A.key)).toBe("gpt-6-sol");
  });

  it("routes each chain entry to its own sign-in", () => {
    setCodexCatalogState(
      { key: codexCredentialKey.user("u1"), accountId: "acct-1" },
      {
        kind: "offered",
        models: [{ ...offered("gpt-6-sol")[0], inputModalities: ["text"] }],
        at: Date.now(),
      },
    );
    expect(chainEntryReadsImages("codex", "u1", null)).toBe(false);
    expect(chainEntryReadsImages("codex", "u2", null)).toBe(true);
    expect(chainEntryReadsImages("admin-codex", "u1", null)).toBe(true);
    expect(chainEntryReadsImages("openai", "u1", "gpt-4")).toBe(false);
    expect(chainEntryReadsImages("anthropic", "u1", "claude-sonnet-4-5")).toBe(
      true,
    );
  });
});
