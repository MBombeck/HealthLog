/**
 * The one reading of an OpenAI model id. Every gate that decides something
 * from an OpenAI or Codex model name asks this function: the reasoning effort
 * and its "off" value (`reasoning/support.ts`), the Chat Completions token
 * field and sampling controls (`openai-capabilities.ts`), and image input
 * (`vision-capability.ts`). A new generation is taught here once instead of
 * in three regexes that drift apart.
 *
 * The facts behind each branch:
 *
 *  - GPT from 5.1 on, the gpt-6 line included, reasons and takes
 *    `effort: "none"`. A live probe on 2026-10-06 answered `none` on gpt-5.5
 *    and listed `'none', 'low', 'medium', 'high', 'xhigh'` as supported.
 *    The upstream Codex catalog (`codex-rs/models-manager/models.json`)
 *    gives gpt-6-sol, gpt-6-luna, gpt-6-astra and gpt-6.1-sol the same
 *    reasoning presets as the gpt-5.6 line (`low` to `max`, sol and astra
 *    also `ultra`). The catalog lists presets, not the wire set: it leaves
 *    `none` out for gpt-5.5 too, which takes it. A model that does refuse
 *    `none` is asked again without reasoning and remembers that
 *    (`reasoning/dialect-cache.ts`), so the assumption costs one retry at
 *    worst. A later generation (`gpt-7`) is read the same way.
 *  - Bare gpt-5 (and its mini / nano / dated snapshots) stops at `minimal`.
 *  - The o-series (o1, o3, o4) starts at `low`.
 *  - Image input: every GPT from 5 on (the catalog lists
 *    `input_modalities: ["text", "image"]` for every gpt-5.x and gpt-6
 *    slug), gpt-4o, gpt-4.1, gpt-4-turbo, and the full o1 / o3 / o4. The
 *    o-series `-mini` / `-preview` variants are text-only, as are gpt-4 and
 *    gpt-3.5.
 *
 * Client-safe: no server import.
 */

/**
 * The reasoning family of an OpenAI model, or `null` for a model that does
 * not reason. `gpt-5.1+` is every GPT generation from 5.1 on, the gpt-6 line
 * included.
 */
export type OpenAIReasoningFamily = "gpt-5.1+" | "gpt-5" | "o" | null;

export interface OpenAIModelFamily {
  /** How the model takes a reasoning effort; `null` when it does not reason. */
  reasoning: OpenAIReasoningFamily;
  /** The model reads image input. */
  vision: boolean;
}

/**
 * `gpt-<major>[.<minor>][o]`, followed by the end or a `-variant`:
 * `gpt-6.1-sol`, `gpt-5-codex-mini`, `gpt-4o-mini`, `gpt-4-turbo`.
 */
const GPT_ID = /^gpt-(\d+)(?:\.(\d+))?(o?)(?=$|-)/;
const O_SERIES_ID = /^o[134](?=$|-)/;

/**
 * What the model family behind `model` can do, or `null` for a name this
 * file does not recognise as an OpenAI model (a gateway alias, a local
 * model, a hidden codename slug). An `openai/` gateway prefix is ignored.
 */
export function openAIModelFamily(model: string): OpenAIModelFamily | null {
  const m = model
    .trim()
    .toLowerCase()
    .replace(/^openai\//, "");

  const gpt = GPT_ID.exec(m);
  if (gpt) {
    const major = Number(gpt[1]);
    const minor = gpt[2] === undefined ? null : Number(gpt[2]);
    const omni = gpt[3] === "o";
    if (major >= 6 || (major === 5 && minor !== null && minor >= 1)) {
      return { reasoning: "gpt-5.1+", vision: true };
    }
    if (major === 5) return { reasoning: "gpt-5", vision: true };
    const rest = m.slice(gpt[0].length);
    const vision =
      major === 4 && (omni || minor === 1 || rest.startsWith("-turbo"));
    return { reasoning: null, vision };
  }

  if (O_SERIES_ID.test(m)) {
    return {
      reasoning: "o",
      vision: !m.includes("-mini") && !m.includes("-preview"),
    };
  }

  return null;
}
