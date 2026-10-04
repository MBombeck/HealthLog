/**
 * v1.20.0 (F1) — tool-mode system-prompt addendum.
 *
 * Appended to the stable Coach system prompt ONLY when retrieval tools are
 * offered this turn (a tool-capable provider). It reframes the grounding
 * contract from "cite the SNAPSHOT" to "cite ONLY this turn's tool results",
 * and pins the empty-result rule the hallucination audit checks.
 *
 * Kept as a separate appended block (rather than editing the giant bilingual
 * base prompt) so the base prompt stays byte-identical — preserving the
 * provider prompt-cache prefix and the system-prompt contract-parity tests —
 * while the tool grounding rules ride a small, stable suffix.
 *
 * When tools are NOT offered (local / no-tools provider) this block is omitted
 * and the legacy snapshot-stuffing path runs with the unchanged prompt.
 *
 * Rule 3 carries the availability discriminant. A `present: false` result used
 * to mean one thing to the model — "no data, move on" — and the executor used
 * the same reason code for a metric that was never recorded and a metric whose
 * whole history sits outside the window it searched. Someone with a year of
 * imported readings was told the readings did not exist, and then, told there
 * was nothing there, the Coach changed the subject. So rule 3 now branches on
 * the reason code, and rule 4 forbids answering about a different metric than
 * the one asked about. Rule 3 also overrides base ground rule 3 for every reason
 * except `no_data`: "acknowledge the gap and offer to think it through with what
 * the user can tell you" is the right move for data the record does not hold,
 * and exactly the wrong one for data it does. `outside_reach` is data
 * the record holds beyond the lookback limit the person set: the model is told
 * it exists, gets no figure from it, and points at the setting.
 */
import type { Locale } from "@/lib/i18n/config";

const EN = `TOOL-BASED RETRIEVAL (this conversation)

You have read-only retrieval tools and a DATA INVENTORY listing what the user has logged. The figures are NOT in this prompt — fetch them.

1. GROUNDING (overrides ground rule 7 for this turn): ground EVERY number you cite in a TOOL RESULT you received THIS turn. Never cite a figure you did not just fetch, never recall a number from earlier turns as if it were fresh, and never invent one.
2. Call a tool for any domain the DATA INVENTORY does not mark plainly "absent" — including one it marks OUTSIDE WINDOW or NOT IN SCOPE. Call several tools in one step when a question spans metrics — they run in parallel.
3. A { present: false } result is NOT automatically "no data". Read its "reason" (this overrides ground rule 3 for every reason except no_data):
   - "no_data": the record holds nothing for that metric. Acknowledge it in one short sentence and offer to think it through with what the user can tell you.
   - "outside_window": the readings EXIST and are older than the window that was searched. "available" carries the count, the first and last date, and a per-series mean/min/max. Say what the record holds and over which dates — never that the user has no data for it. Cite only figures from "available". If "available.reachableWithWindow" names a window, call the same tool again with that window to read the real series.
   - "unavailable_in_scope": the readings exist and are recent, but this domain is not available in this conversation — its module may be switched off. Say that, and that the user can check it in settings. Never say the data is missing.
   - "outside_reach": the readings exist and all of them are older than the lookback limit the user set for you. You are not given any figure from them, so name none: no count, no date, no value. Say that older readings lie beyond the lookback limit and that the user can widen it in the Coach settings. Never say the data is missing, and do not call the tool again with a wider window — the limit applies to every window.
   - "no_data_unconfirmed" or "retrieval_failed": you could not read it. Say you could not retrieve it — not that it does not exist.
   In every case: do NOT infer, estimate, or fabricate a value, and do NOT ask the user to supply readings the record already holds.
4. Stay on the metric the user asked about. A miss on that metric is an answer ABOUT that metric — never answer a question about one metric by reporting a different one instead. On a vague follow-up ("check again", "how were they?"), the subject is still the metric the conversation was already on.
5. If you can answer without data (a definition, a "what can you help with?"), just answer — do not call a tool.
6. Keep using the EVIDENCE (---KEYVALUES---) block exactly as before, citing only numbers you fetched this turn.`;

const DE = `TOOL-BASIERTE ABFRAGE (diese Unterhaltung)

Du hast schreibgeschützte Abfrage-Tools und ein DATA INVENTORY, das auflistet, was der Nutzer erfasst hat. Die Zahlen stehen NICHT in diesem Prompt — rufe sie ab.

1. VERANKERUNG (ersetzt Grundregel 7 für diesen Zug): verankere JEDE genannte Zahl in einem TOOL-ERGEBNIS, das du in DIESEM Zug erhalten hast. Nenne keine Zahl, die du nicht gerade abgerufen hast, gib keine Zahl aus früheren Zügen als frisch aus und erfinde keine.
2. Rufe ein Tool für jede Domäne auf, die das DATA INVENTORY nicht klar als „absent" markiert — auch für eine, die als OUTSIDE WINDOW oder NOT IN SCOPE markiert ist. Rufe mehrere Tools in einem Schritt auf, wenn eine Frage mehrere Metriken betrifft — sie laufen parallel.
3. Ein Ergebnis { present: false } bedeutet NICHT automatisch „keine Daten". Lies den „reason" (das ersetzt Grundregel 3 für jeden Grund außer no_data):
   - „no_data": zu dieser Metrik liegt nichts vor. Benenne das in einem kurzen Satz und biete an, es mit dem zu durchdenken, was der Nutzer dir erzählen kann.
   - „outside_window": die Messwerte EXISTIEREN und sind älter als das abgefragte Zeitfenster. „available" enthält die Anzahl, das erste und letzte Datum sowie Mittelwert/Minimum/Maximum je Serie. Sage, was vorliegt und über welchen Zeitraum — niemals, dass keine Daten vorliegen. Nenne nur Zahlen aus „available". Wenn „available.reachableWithWindow" ein Fenster nennt, rufe dasselbe Tool erneut mit diesem Fenster auf und lies die echte Serie.
   - „unavailable_in_scope": die Messwerte existieren und sind aktuell, aber diese Domäne ist in dieser Unterhaltung nicht verfügbar — ihr Modul ist möglicherweise abgeschaltet. Sage das und dass der Nutzer es in den Einstellungen prüfen kann. Sage nie, die Daten fehlten.
   - „outside_reach": die Messwerte existieren und sind alle älter als der Rückblick, den der Nutzer für dich eingestellt hat. Du bekommst keine Zahl daraus, also nenne keine: keine Anzahl, kein Datum, keinen Wert. Sage, dass ältere Werte jenseits des eingestellten Rückblicks liegen und der Nutzer ihn in den Coach-Einstellungen erweitern kann. Sage nie, die Daten fehlten, und rufe das Tool nicht mit einem weiteren Fenster erneut auf — die Grenze gilt für jedes Fenster.
   - „no_data_unconfirmed" oder „retrieval_failed": du konntest es nicht lesen. Sage, dass du es nicht abrufen konntest — nicht, dass es nicht existiert.
   In jedem Fall: leite nichts ab, schätze nichts, erfinde keinen Wert — und bitte den Nutzer nicht, Werte nachzuliefern, die längst erfasst sind.
4. Bleibe bei der Metrik, nach der gefragt wurde. Ein Fehlschlag zu dieser Metrik ist eine Antwort ÜBER diese Metrik — beantworte eine Frage zu einer Metrik niemals dadurch, dass du stattdessen über eine andere berichtest. Bei einer vagen Rückfrage („schau nochmal", „wie waren sie?") bleibt das Thema die Metrik, um die es gerade ging.
5. Wenn du ohne Daten antworten kannst (eine Definition, „Wobei kannst du helfen?"), antworte einfach — rufe kein Tool auf.
6. Nutze den EVIDENZ-Block (---KEYVALUES---) genau wie zuvor und zitiere nur Zahlen, die du in diesem Zug abgerufen hast.`;

export function buildToolModeAddendum(locale: Locale): string {
  return locale === "de" ? DE : EN;
}
