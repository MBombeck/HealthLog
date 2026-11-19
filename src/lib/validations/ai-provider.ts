/**
 * Request schemas for the AI-provider surfaces: the configuration write
 * (`PATCH /api/user/ai-provider`) and the connection probe
 * (`POST /api/ai/test`).
 *
 * They live outside the route files so the OpenAPI registry can import them (a
 * route module may only export handlers plus the Next.js route config), which
 * keeps the published contract and the runtime parser one object.
 *
 * Both bodies carry plaintext credentials, which puts one constraint on every
 * rule below: a validation message must never interpolate the value it
 * rejected. Zod's built-in type, enum and range messages name the received
 * TYPE and never the received value, so the multi-issue 422 these feed is safe
 * to return. A `.refine()` with a message that quotes its input would break
 * that, and would put a key in an error body.
 */
import {
  AI_RESPONSE_TIMEOUT_MAX_SECONDS,
  AI_RESPONSE_TIMEOUT_MIN_SECONDS,
} from "@/lib/ai/effective-timeout";
import { z } from "zod/v4";

import { PROVIDER_CHAIN_TYPES } from "@/lib/ai/provider-chain";
import { AI_CAPABILITY_KEYS } from "@/lib/ai/capabilities/types";
import {
  CHAIN_ID_PATTERN,
  MAX_CHAIN_NAME_LENGTH,
  MAX_NAMED_CHAINS,
} from "@/lib/ai/named-chains";
import {
  isReasoningProviderType,
  REASONING_EFFORTS,
} from "@/lib/ai/reasoning-effort";

/** The six provider kinds a user may select. */
export const AI_PROVIDER_KINDS = [
  "OPENAI",
  "ANTHROPIC",
  "LOCAL",
  "OPENAI_COMPATIBLE",
  "CHATGPT_OAUTH",
  "ANTIGRAVITY_CLI",
] as const;

export const aiProviderKindSchema = z.enum(AI_PROVIDER_KINDS);

/**
 * A field the caller may set, clear, or leave alone.
 *
 * Three states, and the difference matters on every column here: an OMITTED
 * key leaves the stored value untouched, `null` or `""` clears it, and a
 * non-empty string replaces it. The empty string is not a synonym for "no
 * change" anywhere on this surface — the settings forms send `null` and `""`
 * interchangeably to mean "clear", and both have always cleared.
 */
const clearableString = z.string().nullable();

/**
 * #1126 — a provider entry's reasoning setting. `null` is "Default": nothing
 * is sent and the model decides. `none` is "Off".
 */
export const reasoningEffortSchema = z
  .enum(REASONING_EFFORTS)
  .nullable()
  .describe(
    "Reasoning setting for a Local, OpenAI-compatible, or Antigravity provider, sent as `reasoning_effort` in the `/chat/completions` body or mapped to CLI thought levels. `none` switches reasoning off, which stops a thinking model (Gemma, Qwen and the like) spending the answer budget on reasoning. `null` is Default for supported providers (the key is not sent and the model decides). For other provider types (codex, anthropic, openai, admin-openai) where reasoning effort is not configurable through this field, this is always null.",
  );

/**
 * `PATCH /api/user/ai-provider` — a partial update of the provider config.
 *
 * The route used to inspect the body key by key with `typeof` guards, which
 * meant a wrongly-typed value (a numeric `model`, a boolean `baseUrl`) was
 * SKIPPED rather than refused: the write went ahead without it, and a body of
 * nothing but such keys came back as "No valid fields" without naming one.
 * This schema is what closes that — every accepted field now states its type,
 * and a mismatch is a named issue in the standard multi-issue 422.
 *
 * The accepted field set is exactly what the route already accepted; this
 * describes the existing contract rather than changing it. In particular the
 * object is deliberately NOT `.strict()`: an unrecognised key has always been
 * ignored here, and refusing one now would break a client sending a field this
 * server does not know yet. Unknown keys are dropped, as before.
 */
export const aiProviderPatchSchema = z.object({
  /**
   * The selected provider. `null` / `""` clears it. Unlike every other field
   * this one has always REFUSED an unrecognised value rather than skipping it,
   * and still does.
   */
  provider: z
    .union([aiProviderKindSchema, z.literal("")])
    .nullable()
    .optional(),
  /** Trimmed on write; whitespace-only clears, like `""`. */
  model: clearableString.optional(),
  /**
   * Custom base URL for the LOCAL provider. Trimmed, then run through the
   * SSRF floor at the route — a private host is refused there, not here,
   * because the allowlist is operator state rather than a shape rule.
   */
  baseUrl: clearableString.optional(),
  /** The OpenAI-compatible gateway's own base URL. Same SSRF floor. */
  compatBaseUrl: clearableString.optional(),
  compatModel: clearableString.optional(),
  /** Encrypted at rest on write; never echoed back by the read. */
  compatKey: clearableString.optional(),
  anthropicKey: clearableString.optional(),
  localKey: clearableString.optional(),
  openaiKey: clearableString.optional(),
  /**
   * Per-user AI response timeout in seconds. `null` restores the built-in
   * default. The 10 s floor is below what any real backend beats and the
   * 600 s ceiling is generous for a slow self-hosted one; outside that range
   * the value is refused rather than clamped, so a typo is visible.
   */
  responseTimeoutSeconds: z
    .number()
    .int()
    .min(
      AI_RESPONSE_TIMEOUT_MIN_SECONDS,
      "Response timeout must be between 10 and 600 seconds",
    )
    .max(
      AI_RESPONSE_TIMEOUT_MAX_SECONDS,
      "Response timeout must be between 10 and 600 seconds",
    )
    .nullable()
    .optional(),
  /**
   * #1126 — the reasoning setting of the Local entry. Stored on the entry in
   * the provider chain; a chain never customised is materialised from the
   * default to hold it. `null` restores Default.
   */
  localReasoningEffort: reasoningEffortSchema
    .optional()
    .describe(
      "Reasoning setting of the Local provider entry, stored on that entry of the provider chain. `none` = Off, `null` = Default (nothing sent). Omitted leaves it untouched.",
    ),
  /** #1126 — the same for the OpenAI-compatible gateway entry. */
  compatReasoningEffort: reasoningEffortSchema
    .optional()
    .describe(
      "Reasoning setting of the OpenAI-compatible gateway entry, stored on that entry of the provider chain. `none` = Off, `null` = Default (nothing sent). Omitted leaves it untouched.",
    ),
});

export type AiProviderPatchInput = z.infer<typeof aiProviderPatchSchema>;

export const aiTestOverrideSchema = z
  .object({
    provider: aiProviderKindSchema.optional().nullable(),
    model: z.string().min(1).max(120).optional().nullable(),
    baseUrl: z.string().url().max(2048).optional().nullable(),
    anthropicKey: z.string().min(1).max(500).optional().nullable(),
    localKey: z.string().min(1).max(500).optional().nullable(),
    openaiKey: z.string().min(1).max(500).optional().nullable(),
    // The OpenAI-compatible gateway's own fields, kept separate from
    // `baseUrl` / `openaiKey` so testing an unsaved gateway config can never
    // reach the pinned OpenAI arm and vice versa.
    compatBaseUrl: z.string().url().max(2048).optional().nullable(),
    compatKey: z.string().min(1).max(500).optional().nullable(),
    compatModel: z.string().min(1).max(120).optional().nullable(),
  })
  .strict();

export type AiTestOverrideInput = z.infer<typeof aiTestOverrideSchema>;

/**
 * One entry of `PUT /api/insights/provider-chain`. Shared by the route and the
 * OpenAPI registry, so the published contract and the parser are one object.
 */
export const providerChainEntrySchema = z
  .object({
    providerType: z
      .enum(PROVIDER_CHAIN_TYPES)
      .describe(
        "Closed allow-list. The mock provider is excluded from it structurally, which is what keeps production from reaching one.",
      ),
    // Priority is recomputed server-side from insertion order so a stale
    // client cannot persist a chain whose displayed order disagrees with
    // its priority field. The number is accepted (and may be present) but
    // ignored on the wire.
    priority: z
      .number()
      .int()
      .optional()
      .describe(
        "ACCEPTED AND IGNORED. Priority is recomputed from the array's insertion order, so a stale client cannot persist a chain whose displayed order disagrees with its stored one. Send the order you want as the order of the array.",
      ),
    enabled: z.boolean(),
    reasoningEffort: reasoningEffortSchema
      .optional()
      .describe(
        "Only on a `local`, `openai-compatible` or `antigravity` entry; refused on any other. Omitted keeps the value already stored for that provider, `null` restores Default, `none` / `low` / `medium` / `high` are sent as reasoning effort.",
      ),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (
      entry.reasoningEffort !== undefined &&
      !isReasoningProviderType(entry.providerType)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["reasoningEffort"],
        message:
          "A reasoning setting applies to the local, openai-compatible and antigravity providers only",
      });
    }
  });

export const providerChainPutSchema = z
  .object({
    chain: z
      .array(providerChainEntrySchema)
      .min(1, "Chain must contain at least one provider")
      .max(PROVIDER_CHAIN_TYPES.length, "Too many providers")
      .describe(
        "The whole chain, in the order it should be walked. At least one entry and at most one per known provider type; a repeated type is refused.",
      ),
  })
  .strict();

export type ProviderChainPutInput = z.infer<typeof providerChainPutSchema>;

/**
 * #1404 — `PUT /api/insights/provider-chains`: the account's named chains,
 * which of them is the default, and which capability is attached to which.
 * Replaced wholesale. Shared by the route and the OpenAPI registry.
 */
export const namedChainSchema = z
  .object({
    id: z
      .string()
      .regex(CHAIN_ID_PATTERN)
      .describe(
        "Chosen by the client that creates the chain (letters, digits, `-`, `_`; at most 32). Stable across renames; attachments and the default refer to it.",
      ),
    name: z
      .string()
      .trim()
      .min(1)
      .max(MAX_CHAIN_NAME_LENGTH)
      .describe("Shown in settings. Unique per account, ignoring case."),
    entries: z
      .array(z.enum(PROVIDER_CHAIN_TYPES))
      .min(1, "A chain needs at least one provider")
      .max(PROVIDER_CHAIN_TYPES.length)
      .describe(
        "Provider types in the order they are tried. One entry is a binding: the capability uses that provider or refuses. A repeated type is refused.",
      ),
  })
  .strict();

export const namedChainsPutSchema = z
  .object({
    chains: z.array(namedChainSchema).max(MAX_NAMED_CHAINS),
    defaultChainId: z
      .string()
      .nullable()
      .describe(
        "The named chain every unattached capability follows, or null for the main chain (`/api/insights/provider-chain`).",
      ),
    attachments: z
      .partialRecord(z.enum(AI_CAPABILITY_KEYS), z.string())
      .describe(
        "Capability → chain id. A capability left out follows the default chain under its own rules.",
      ),
  })
  .strict()
  .superRefine((body, ctx) => {
    const ids = new Set<string>();
    const names = new Set<string>();
    body.chains.forEach((chain, index) => {
      if (ids.has(chain.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["chains", index, "id"],
          message: "Duplicate chain id",
        });
      }
      ids.add(chain.id);
      const name = chain.name.toLowerCase();
      if (names.has(name)) {
        ctx.addIssue({
          code: "custom",
          path: ["chains", index, "name"],
          message: "Duplicate chain name",
        });
      }
      names.add(name);
      if (new Set(chain.entries).size !== chain.entries.length) {
        ctx.addIssue({
          code: "custom",
          path: ["chains", index, "entries"],
          message: "Duplicate provider in chain",
        });
      }
    });
    if (body.defaultChainId !== null && !ids.has(body.defaultChainId)) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultChainId"],
        message: "Unknown chain",
      });
    }
    for (const [key, chainId] of Object.entries(body.attachments)) {
      if (chainId !== undefined && !ids.has(chainId)) {
        ctx.addIssue({
          code: "custom",
          path: ["attachments", key],
          message: "Unknown chain",
        });
      }
    }
  });

export type NamedChainsPutInput = z.infer<typeof namedChainsPutSchema>;
