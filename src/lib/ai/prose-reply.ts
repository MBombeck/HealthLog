/**
 * The prose of a model reply that was asked for prose.
 *
 * A call that asks for plain text ("return the summary text only") does not
 * always get it. Some models answer in the shape they associate with the task
 * anyway: `{"summary": "…"}`, the same object inside a ```json fence, or a
 * fence around the text itself. Stored as it came, the wrapper is what the
 * person reads ("{"summary": "This is a lab report …"}").
 *
 * `proseFromModelReply` returns the text inside such a wrapper and anything
 * else unchanged. It unwraps only a reply that is wholly one wrapper: a JSON
 * object whose one text field is the answer (by the expected key, or by the
 * usual prose keys), or one fence around the whole reply. Prose that merely
 * contains braces stays as it is. Every caller that stores or shows model
 * prose runs its reply through this before using it.
 */

/** Keys a model puts prose under when it wraps an answer it was asked to give bare. */
const PROSE_KEYS = [
  "summary",
  "text",
  "content",
  "answer",
  "response",
  "message",
  "description",
  "result",
  "output",
  "line",
  "nudge",
] as const;

const WHOLE_FENCE = /^```[A-Za-z0-9_-]*[ \t]*\n?([\s\S]*?)\n?```$/;

function pickProse(value: unknown, expectedKey?: string): string | null {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (expectedKey && typeof record[expectedKey] === "string") {
    return record[expectedKey] as string;
  }
  const entries = Object.entries(record);
  const strings = entries.filter(([, v]) => typeof v === "string");
  // One field holding all of it: whatever its name, that is the answer.
  if (entries.length === 1 && strings.length === 1) {
    return strings[0][1] as string;
  }
  const prose = strings.filter(([k]) =>
    (PROSE_KEYS as readonly string[]).includes(k.toLowerCase()),
  );
  return prose.length === 1 ? (prose[0][1] as string) : null;
}

/**
 * A `{ key: "…" }` object a model wrote with unquoted keys or single quotes,
 * which `JSON.parse` refuses: one key, one quoted string.
 */
function looseSingleField(text: string, expectedKey?: string): string | null {
  const m =
    /^\{\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*:\s*(["'])([\s\S]*)\2\s*,?\s*\}$/.exec(
      text,
    );
  if (!m) return null;
  const key = m[1].toLowerCase();
  if (
    key !== expectedKey?.toLowerCase() &&
    !(PROSE_KEYS as readonly string[]).includes(key)
  ) {
    return null;
  }
  return m[3]
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\(["'\\])/g, "$1");
}

export function proseFromModelReply(raw: string, expectedKey?: string): string {
  const original = raw.trim();
  let text = original;
  const fenced = WHOLE_FENCE.exec(text);
  if (fenced) text = fenced[1].trim();

  if (text.startsWith("{") && text.endsWith("}")) {
    let unwrapped: string | null = null;
    try {
      unwrapped = pickProse(JSON.parse(text), expectedKey);
    } catch {
      unwrapped = looseSingleField(text, expectedKey);
    }
    if (unwrapped !== null) {
      const clean = unwrapped.trim();
      // An empty field is no answer; keep what came rather than nothing.
      return clean.length > 0 ? clean : original;
    }
    // An object with no single text answer: not a wrapper we can read.
    return original;
  }
  if (text.startsWith('"') && text.endsWith('"') && text.length > 1) {
    try {
      const s: unknown = JSON.parse(text);
      if (typeof s === "string" && s.trim()) return s.trim();
    } catch {
      // Not a JSON string: prose that happens to be quoted.
    }
  }
  return fenced && text.length > 0 ? text : original;
}
