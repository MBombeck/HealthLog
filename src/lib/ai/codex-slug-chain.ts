/**
 * The Codex slug ladder: which ChatGPT-auth model slugs the client tries, in
 * order, and the slug the vision gate reasons about before a request runs.
 * The walk itself (which statuses move to the next rung) lives in
 * `codex-client.ts`; the per-sign-in memory in `codex-slug-cache.ts`; the
 * account's own model list in `codex-model-catalog.ts`.
 * docs/codex-protocol-spec.md §7b describes the whole defence.
 */
import { annotate } from "@/lib/logging/context";
import {
  cachedCodexModels,
  readCodexModelCatalog,
  type CodexCatalogRead,
  type CodexOfferedModel,
} from "./codex-model-catalog";
import {
  codexCredentialKey,
  getCachedCodexSlug,
  rejectedCodexSlugs,
  type CodexCredential,
} from "./codex-slug-cache";
import {
  supportsVisionForConfig,
  type VisionProviderType,
} from "./vision-capability";

/**
 * Our preference order. With the account's model list in hand it is filtered
 * to what the account is offered; without it, it is the walk. Override via
 * `CODEX_MODEL_FALLBACK_CHAIN` (comma-separated); `CODEX_MODEL` is folded
 * into position 0 when set, duplicates dropped.
 *
 * `gpt-5.6-terra` stays first because it is the slug verified against the
 * backend. The upstream catalog (`codex-rs/models-manager/models.json`)
 * names `gpt-6-sol` as its upgrade, and the last rotation retired a whole
 * line at once, so the gpt-6 rungs come next rather than terra's siblings:
 * `gpt-6-sol` (terra's named successor), `gpt-6.1-sol` (the catalog's
 * default, also offered on plans `gpt-6-sol` is not), `gpt-6-luna` (the
 * lighter one). `gpt-6-astra`, the frontier tier, is left out: it spends a
 * plan's allowance fastest for no gain on these prompts.
 */
export const DEFAULT_SLUG_FALLBACK_CHAIN = [
  "gpt-5.6-terra", // verified against the backend 2026-10-24
  "gpt-6-sol", // terra's upgrade in the upstream catalog
  "gpt-6.1-sol", // the catalog default, on every plan
  "gpt-6-luna", // lighter gpt-6 sibling
  "gpt-5.6-luna", // lighter sibling on terra's line
  "gpt-5.6-sol", // heavier sibling on terra's line
  "gpt-5.5", // previous default, kept as the last rung while plans differ
] as const;

/**
 * The frontier tier (`gpt-6-astra` today, and any later `-astra`), skipped
 * even when offered, for the reason on `DEFAULT_SLUG_FALLBACK_CHAIN`. An
 * operator who wants it names it in `CODEX_MODEL`.
 */
const SKIPPED_TIER = /(?:^|-)astra(?:$|-)/;

/** Where the order a client walks came from. A closed set: it is log meta. */
export type CodexChainSource = "operator" | "live" | "static";

function dedupe(slugs: readonly string[]): string[] {
  return [...new Set(slugs)];
}

/** The `CODEX_MODEL` pin and the `CODEX_MODEL_FALLBACK_CHAIN` replacement. */
function operatorChoice(): { pinned: string | null; chain: string[] | null } {
  const envChain = process.env.CODEX_MODEL_FALLBACK_CHAIN?.trim();
  const chain = envChain
    ? envChain
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
  return {
    pinned: process.env.CODEX_MODEL?.trim() || null,
    chain: chain && chain.length > 0 ? chain : null,
  };
}

/** Whether the operator replaced the chain, so the account's list is not read. */
function operatorReplacedCodexChain(): boolean {
  return operatorChoice().chain !== null;
}

/**
 * The order a client walks for one sign-in.
 *
 *   1. The operator's choice, unchanged in meaning: `CODEX_MODEL` goes first;
 *      `CODEX_MODEL_FALLBACK_CHAIN` replaces everything after it, and the
 *      account's list is then not consulted at all.
 *   2. Our preference order, kept to what the account is offered.
 *   3. Every other offered model, in the list's own order (`priority`, as the
 *      Codex CLI sorts it), leaving out what the list hides from its picker
 *      (`visibility` other than `list`: review and specialist models), the
 *      specialist lines (`model_specialty`), and the skipped frontier tier.
 *      `supported_in_api` is not a filter: it describes API-key access, and
 *      the Codex CLI ignores it for a ChatGPT sign-in (`filter_by_auth`).
 *   4. The rest of our preference order, last. A list that offers a model the
 *      backend then refuses must not be able to take Codex down, so the walk
 *      never holds fewer models than it did before the list was read; these
 *      only cost a refused request when everything ahead of them failed.
 *
 * Without a usable list (none read, a failed read, an empty one) the order is
 * today's static walk. Models this sign-in was refused recently move to the
 * very end, in their order, whatever step placed them.
 */
export function buildCodexSlugChain(input: {
  offered: readonly CodexOfferedModel[] | null;
  rejected?: ReadonlySet<string>;
}): { chain: string[]; source: CodexChainSource } {
  const { pinned, chain: operatorChain } = operatorChoice();
  let ordered: string[];
  let source: CodexChainSource;
  if (operatorChain) {
    ordered = operatorChain;
    source = "operator";
  } else if (!input.offered || input.offered.length === 0) {
    ordered = [...DEFAULT_SLUG_FALLBACK_CHAIN];
    source = "static";
  } else {
    const usable = input.offered.filter(
      (m) => m.listed && m.specialty === null && !SKIPPED_TIER.test(m.slug),
    );
    const usableSlugs = new Set(usable.map((m) => m.slug));
    const preferred = DEFAULT_SLUG_FALLBACK_CHAIN.filter((s) =>
      usableSlugs.has(s),
    );
    const others = usable
      .map((m, index) => ({ m, index }))
      .sort(
        (a, b) =>
          (a.m.priority ?? Number.POSITIVE_INFINITY) -
            (b.m.priority ?? Number.POSITIVE_INFINITY) || a.index - b.index,
      )
      .map(({ m }) => m.slug);
    ordered = [...preferred, ...others, ...DEFAULT_SLUG_FALLBACK_CHAIN];
    source = "live";
  }
  const walk = dedupe(pinned ? [pinned, ...ordered] : ordered);
  const rejected = input.rejected ?? new Set<string>();
  return {
    chain: [
      ...walk.filter((s) => !rejected.has(s)),
      ...walk.filter((s) => rejected.has(s)),
    ],
    source,
  };
}

/** How a client reads its account's model list. */
export type CodexModelReader = typeof readCodexModelCatalog;

/**
 * The walk a client runs after its working slug, for one sign-in, with the
 * outcome on the request's wide event (pinned shape, closed values):
 *
 *   - `codex.models.chain`: where the order came from (`CodexChainSource`);
 *   - `codex.models.read`: `live`, `cache`, or `skipped` when the operator
 *     replaced the chain and the list was not asked;
 *   - `codex.models.failure`: why the list was unusable (`CodexCatalogFailure`)
 *     or null;
 *   - `codex.models.offered`: how many models the list offered (0 without one).
 *
 * `slugChain` and `readModels` are test seams: `slugChain` replaces the walk
 * the way `CODEX_MODEL_FALLBACK_CHAIN` does (the list is not read, refused
 * slugs still go last); `readModels` stands in for the backend read.
 */
export async function loadCodexAttemptChain(input: {
  credential: CodexCredential;
  accessToken: string;
  slugChain?: readonly string[];
  readModels?: CodexModelReader;
}): Promise<string[]> {
  const rejected = rejectedCodexSlugs(input.credential.key);
  if (input.slugChain && input.slugChain.length > 0) {
    return [
      ...input.slugChain.filter((s) => !rejected.has(s)),
      ...input.slugChain.filter((s) => rejected.has(s)),
    ];
  }
  let read: CodexCatalogRead | null = null;
  if (!operatorReplacedCodexChain()) {
    const reader = input.readModels ?? readCodexModelCatalog;
    // The reader never rejects by contract; a bug in it must still leave
    // the static walk rather than fail the request.
    read = await reader(input.credential, {
      accessToken: input.accessToken,
      accountId: input.credential.accountId,
    }).catch((): CodexCatalogRead => ({
      models: null,
      from: "live",
      failure: "network",
    }));
  }
  const { chain, source } = buildCodexSlugChain({
    offered: read?.models ?? null,
    rejected,
  });
  annotate({
    meta: {
      "codex.models.chain": source,
      "codex.models.read": read?.from ?? "skipped",
      "codex.models.failure": read?.failure ?? null,
      "codex.models.offered": read?.models?.length ?? 0,
    },
  });
  return chain;
}

/**
 * The slug the codex vision gate reasons about *before* a request runs, for
 * one sign-in: its working slug if one is live, else the head of the order
 * built from its last model list (or the static walk). Lets the vision
 * resolvers decide whether codex can read images without standing up a
 * client or making a network call. Best-effort: the routed slug may differ
 * once the walk runs, which the runtime probe and the text / local OCR
 * fallback cover.
 */
export function resolveCodexVisionSlug(credentialKey: string): string | null {
  const cached = getCachedCodexSlug(credentialKey);
  if (cached) return cached;
  const { chain } = buildCodexSlugChain({
    offered: operatorReplacedCodexChain()
      ? null
      : cachedCodexModels(credentialKey),
    rejected: rejectedCodexSlugs(credentialKey),
  });
  return chain[0] ?? null;
}

/**
 * Whether this sign-in's Codex model reads images. When the account's list
 * names the model's `input_modalities`, that answer wins; otherwise the model
 * family decides (`supportsVisionForConfig`), as it did before the list.
 */
export function codexSignInReadsImages(credentialKey: string): boolean {
  const slug = resolveCodexVisionSlug(credentialKey);
  if (!slug) return false;
  const offered = cachedCodexModels(credentialKey)?.find(
    (m) => m.slug === slug,
  );
  if (offered?.inputModalities) {
    return offered.inputModalities.includes("image");
  }
  return supportsVisionForConfig("codex", slug);
}

/**
 * Whether a provider chain entry can read images, for the vision resolvers.
 * A Codex entry asks its own sign-in (`codex` the person's connection,
 * `admin-codex` the operator-shared one); every other entry is decided by
 * `model`'s family, as before.
 */
export function chainEntryReadsImages(
  providerType: string,
  userId: string,
  model: string | null,
): boolean {
  if (providerType === "codex") {
    return codexSignInReadsImages(codexCredentialKey.user(userId));
  }
  if (providerType === "admin-codex") {
    return codexSignInReadsImages(codexCredentialKey.central);
  }
  return supportsVisionForConfig(providerType as VisionProviderType, model);
}
