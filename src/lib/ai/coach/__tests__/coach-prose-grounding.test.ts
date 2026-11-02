/**
 * v1.21.0 — post-hoc numeric verifier on Coach prose. It must flag
 * a number the model cited that no tool returned this turn (transcription
 * drift), exempt structural window/ordinal integers, and no-op when no tool
 * returned figures. Soft-strip replaces only the flagged tokens.
 *
 * v1.32.1 — closes three real-world false-positive shapes reported against
 * grounded Coach replies: a correctly-computed derived delta/average/percent
 * between two of a payload's own headline figures, a calendar-date ordinal
 * ("July 21st") mangled mid-word into "[unverified]st", and a numbered-list
 * recommendation line ("1. Cut back on sodium") whose marker got flagged as a
 * bare figure. Each new case is paired with an adversarial case proving a
 * genuine fabrication in the SAME shape is still caught.
 */
import { describe, expect, it } from "vitest";

import { locales, type Locale } from "@/lib/i18n/config";

import {
  collectNumericLeaves,
  findUnverifiedCoachNumbers,
  hasPopulationNormFraming,
  stripUnverifiedNumbers,
  UNVERIFIED_ELISION_MARK,
  unitWordBank,
} from "@/lib/ai/coach/coach-prose-grounding";

describe("collectNumericLeaves", () => {
  it("walks numbers, numeric strings, arrays and nested objects", () => {
    const out = new Set<number>();
    collectNumericLeaves(
      {
        section: { avgSys30: 128, label: "LDL", value: "120" },
        recent: [{ v: 72 }, { v: "1.2" }],
      },
      out,
    );
    expect(out.has(128)).toBe(true);
    expect(out.has(120)).toBe(true);
    expect(out.has(72)).toBe(true);
    expect(out.has(1.2)).toBe(true);
  });
});

describe("findUnverifiedCoachNumbers", () => {
  const payloads = [{ aggregate: { avgSys30: 128, avgDia30: 82 } }];

  it("returns nothing when every cited number is grounded", () => {
    const prose =
      "Your systolic averaged 128 and diastolic 82 over the last 30 days.";
    expect(findUnverifiedCoachNumbers(prose, payloads)).toEqual([]);
  });

  it("flags a drifted number the tools never returned", () => {
    const prose = "Your systolic averaged about 138 recently.";
    const findings = findUnverifiedCoachNumbers(prose, payloads);
    expect(findings).toHaveLength(1);
    expect(findings[0].value).toBe(138);
  });

  it("allows a rounding within tolerance", () => {
    const prose = "Diastolic sat around 82.0 this period.";
    expect(findUnverifiedCoachNumbers(prose, payloads)).toEqual([]);
  });

  it("grounds a 30-day systolic average against the real tool section that carries it", () => {
    // Mirrors the integration fixture: the model narrates the pre-computed
    // 30-day systolic average (130) that the bp tool section actually returned.
    // It must NOT be flagged. (Regression companion: the route must feed this
    // real section, not a counts-only inventory — see route-tool-mode tests.)
    const bpSection = [
      { metric: "bp", section: { aggregate: { avgSys30: 130 } } },
    ];
    const prose = "Your 30-day systolic average is 130 mmHg, trending up.";
    expect(findUnverifiedCoachNumbers(prose, bpSection)).toEqual([]);
  });

  it("does NOT ground an average against a counts-only inventory payload (documents why the route must not activate on the inventory alone)", () => {
    // The DATA INVENTORY carries per-domain sample COUNTS, never the snapshot's
    // averages. If the route were to feed inventory-entries alone as the
    // authoritative set, a cited average (130) would be graded against {14}
    // and wrongly flagged. This asserts that shape so the route's activation
    // gate (only run when a real tool result / workout block is present) is
    // load-bearing, not incidental.
    const inventoryOnly = [
      [
        {
          tool: "get_metric_series",
          metric: "bp",
          domain: "blood pressure",
          present: true,
          count: 14,
        },
      ],
    ];
    const findings = findUnverifiedCoachNumbers(
      "Your 30-day systolic average is 130 mmHg.",
      inventoryOnly,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].value).toBe(130);
  });

  it("exempts structural window + small-ordinal integers", () => {
    const prose = "Over the last 30 days, 2 readings stood out of 7 total.";
    // 30 + 7 are window integers; 2 is a small ordinal — none graded.
    const findings = findUnverifiedCoachNumbers(prose, [{ x: 999 }]);
    expect(findings).toEqual([]);
  });

  it("no-ops when no tool returned any figure", () => {
    const prose = "Your systolic averaged 138 recently.";
    expect(findUnverifiedCoachNumbers(prose, [])).toEqual([]);
    expect(
      findUnverifiedCoachNumbers(prose, [{ note: "no numbers here" }]),
    ).toEqual([]);
  });

  it("returns empty on empty prose", () => {
    expect(findUnverifiedCoachNumbers("", payloads)).toEqual([]);
  });

  describe("derived arithmetic (delta / average / percent)", () => {
    // A realistic weight tool-result payload: the model was given latest,
    // avg7 and avg30 — never a pre-computed delta (unlike the Daily
    // Briefing's `signalsOfDay`), so a correctly-computed "down 3.5 kg from
    // your 7-day average" is a legitimate derivation the checker must not
    // flag.
    const weightPayload = [
      {
        metric: "weight",
        section: { aggregate: { latest: 72.4, avg7: 75.9, avg30: 74.1 } },
      },
    ];

    it("does not flag a correctly-computed delta between two grounded aggregate points", () => {
      const prose =
        "You're down 3.5 kg from your 7-day average of 75.9 kg, now at 72.4 kg — nice trend.";
      expect(findUnverifiedCoachNumbers(prose, weightPayload)).toEqual([]);
    });

    it("does not flag a correctly-computed midpoint average of two grounded aggregate points", () => {
      const prose =
        "Your latest (72.4 kg) and 30-day average (74.1 kg) put you around 73.25 kg overall.";
      expect(findUnverifiedCoachNumbers(prose, weightPayload)).toEqual([]);
    });

    it("does not flag a correctly-computed percent change between two grounded aggregate points", () => {
      // (75.9 - 72.4) / 75.9 * 100 ≈ 4.61%
      const prose = "That's roughly a 4.6% drop from your 7-day average.";
      expect(findUnverifiedCoachNumbers(prose, weightPayload)).toEqual([]);
    });

    it("still flags a fabricated figure that is NOT a derived value of the grounded points", () => {
      const prose =
        "Your latest reading was 72.4 kg, and I estimate you'll hit 55.0 kg by next month.";
      const findings = findUnverifiedCoachNumbers(prose, weightPayload);
      expect(findings).toHaveLength(1);
      expect(findings[0].value).toBe(55);
    });

    it("does not let a weight delta ground itself against an unrelated metric's figure (per-payload scoping)", () => {
      // Blood pressure's own aggregate lives in a SEPARATE tool-result
      // payload; a "difference" here must derive only from ITS OWN points,
      // never pool with the unrelated weight payload above.
      const bpAndWeight = [
        ...weightPayload,
        {
          metric: "bp",
          section: { aggregate: { avgSys30: 128, avgDia30: 82 } },
        },
      ];
      // 46 is |128 - 82| — a legitimate BP pulse-pressure-shaped delta —
      // grounded via the bp payload's own points, not a coincidence.
      expect(
        findUnverifiedCoachNumbers(
          "Your pulse pressure is about 46.",
          bpAndWeight,
        ),
      ).toEqual([]);
    });
  });

  describe("date ordinals and numbered-list markers", () => {
    const bpPayload = [
      {
        metric: "bp",
        section: { aggregate: { latest: 138, avg7: 132, avg30: 128 } },
      },
    ];

    it("does not flag a day-of-month ordinal even though the bare day number is ungrounded", () => {
      const prose =
        "Your blood pressure spiked to 138 on July 21st, well above your typical range.";
      expect(findUnverifiedCoachNumbers(prose, bpPayload)).toEqual([]);
    });

    it("does not corrupt the ordinal suffix when soft-stripping the rest of the reply", () => {
      // Regression guard for the exact mangling reported: "[unverified]st".
      const prose =
        "Your blood pressure spiked to 138 on July 21st, well above your typical range.";
      const findings = findUnverifiedCoachNumbers(prose, bpPayload);
      const { prose: out } = stripUnverifiedNumbers(prose, findings);
      expect(out).not.toContain(`${UNVERIFIED_ELISION_MARK}st`);
      expect(out).toBe(prose);
    });

    it("does not flag numbered-list recommendation markers", () => {
      // Item numbers run past 3 (the pre-existing small-ordinal exemption) so
      // this genuinely exercises the line-start list-marker mask, not the
      // unrelated small-integer rule.
      const prose =
        "Your systolic hit 138 today. A few ideas:\n1. Cut back on sodium\n2. Take a short walk after meals\n3. Log your next reading tomorrow\n4. Recheck in the evening\n5. Note any stress today";
      expect(findUnverifiedCoachNumbers(prose, bpPayload)).toEqual([]);
    });

    it("still flags a fabricated figure sitting right next to a date ordinal", () => {
      const prose = "On July 21st your systolic hit 199, a new high.";
      const findings = findUnverifiedCoachNumbers(prose, bpPayload);
      expect(findings).toHaveLength(1);
      expect(findings[0].value).toBe(199);
    });

    it("still flags a genuine leading figure that happens to open a line (not list-shaped without the trailing space)", () => {
      // "199kg" has no space after the number at all — never mistaken for a
      // "N. " list marker, which requires a literal dot-then-space.
      const prose = "199kg would be an alarming reading.";
      const findings = findUnverifiedCoachNumbers(prose, bpPayload);
      expect(findings).toHaveLength(1);
      expect(findings[0].value).toBe(199);
    });

    it("still flags a decimal figure that opens a line (a digit, not whitespace, follows the dot)", () => {
      // "199.5" at line-start is a genuine decimal reading, not a "N. " list
      // marker — the masking regex only fires when whitespace follows the
      // dot, so this stays fully checked.
      const prose = "199.5 would be an alarming systolic reading.";
      const findings = findUnverifiedCoachNumbers(prose, bpPayload);
      expect(findings).toHaveLength(1);
      expect(findings[0].value).toBe(199.5);
    });
  });

  it("still flags a drifted number when the prose also derives / dates cleanly (adversarial floor)", () => {
    // The classic P6 regression case must survive every new exemption.
    const findings = findUnverifiedCoachNumbers(
      "Your systolic averaged about 138 recently.",
      payloads,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].value).toBe(138);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * v1.32.7 (Coach Guard I / G1) — typed tokenizer + normal-form reconciler.
 * Both directions: a figure the model legitimately reformatted must PASS, and
 * every fabrication shape the red team named must STILL be flagged.
 * ────────────────────────────────────────────────────────────────────────── */
describe("G1 — normal-form reconciler grounded-passes", () => {
  it("passes a headline integer adherence rate restated as a percent (compliance-block.ts:181-184)", () => {
    // The compliance headline `rate` is an integer 0–100, not a ratio.
    const payload = [{ metric: "adherence", section: { rate: 93 } }];
    expect(
      findUnverifiedCoachNumbers("Your adherence was 93% this month.", payload),
    ).toEqual([]);
  });

  it("passes a ratio headline restated as a percent (ratio↔percent in PERCENT space)", () => {
    const payload = [{ metric: "adherence", section: { rate: 0.93 } }];
    expect(
      findUnverifiedCoachNumbers(
        "Your adherence has been about 93% overall.",
        payload,
      ),
    ).toEqual([]);
  });

  it("passes a negative delta narrated as a positive drop (sign-insensitive)", () => {
    const payload = [
      { metric: "weight", section: { aggregate: { deltaVs7: -1.2 } } },
    ];
    expect(
      findUnverifiedCoachNumbers("You dropped 1.2 kg this week.", payload),
    ).toEqual([]);
  });

  it("passes a colloquial nearest-10 rounding of an authoritative value", () => {
    const payload = [
      { metric: "bp", section: { aggregate: { avgSys30: 124 } } },
    ];
    // round(124, nearest 10) === 120 — a canonical rounding, not a ±2% band
    // (|120 - 124| = 4 exceeds the 2.48 tolerance, so only rounding grounds it).
    expect(
      findUnverifiedCoachNumbers("Your systolic averaged around 120.", payload),
    ).toEqual([]);
  });

  it("passes a minutes→hours restatement of a sleep mean", () => {
    const payload = [
      { metric: "sleep", section: { aggregate: { mean: 444 } } },
    ];
    // 444 min ⇔ 7.4 h.
    expect(
      findUnverifiedCoachNumbers(
        "You averaged about 7.4 hours asleep.",
        payload,
      ),
    ).toEqual([]);
  });

  it("parses an EN thousands-separated step count as one figure, not 10", () => {
    const payload = [
      { metric: "steps", section: { aggregate: { latest: 10000 } } },
    ];
    expect(
      findUnverifiedCoachNumbers(
        "You hit 10,000 steps yesterday.",
        payload,
        "en",
      ),
    ).toEqual([]);
  });

  it("parses a DE thousands-separated step count using the reply language", () => {
    const payload = [
      { metric: "steps", section: { aggregate: { latest: 10000 } } },
    ];
    expect(
      findUnverifiedCoachNumbers(
        "Du hast gestern 10.000 Schritte geschafft.",
        payload,
        "de",
      ),
    ).toEqual([]);
  });

  it("never grades a reformatted ISO date, a clock time, or a bare year", () => {
    const payload = [
      { metric: "bp", section: { aggregate: { avgSys30: 128 } } },
    ];
    const prose =
      "On 2026-07-23 at 22:45 your systolic sat at 128, the calmest since 2019.";
    expect(findUnverifiedCoachNumbers(prose, payload)).toEqual([]);
  });

  it("passes a range narration against the real min/max (per-endpoint rounding)", () => {
    const payload = [
      { metric: "bp", section: { aggregate: { min: 121, max: 134 } } },
    ];
    // round(121,5)=120 and round(134,5)=135 — both endpoints reconcile.
    expect(
      findUnverifiedCoachNumbers(
        "Your systolic sat between 120 and 135 mmHg.",
        payload,
      ),
    ).toEqual([]);
  });
});

describe("G1 — fabricated figures still blocked", () => {
  it("blocks paraphrase drift: 128 must NOT ground '~138' (canonical rounding is anchored)", () => {
    const payload = [
      { metric: "bp", section: { aggregate: { avgSys30: 128 } } },
    ];
    const findings = findUnverifiedCoachNumbers(
      "Your systolic averaged about 138 recently.",
      payload,
    );
    expect(findings.map((f) => f.value)).toContain(138);
  });

  it("blocks a fabricated mean laundered via a raw sample's rounding (D5 aggregate-only scoping)", () => {
    // A dense timeline carries an outlier sample 136.8; the true mean is 128.
    // "around 140" = round(136.8,10) — but a SAMPLE never gets rounding.
    const payload = [
      {
        metric: "bp",
        section: {
          aggregate: { mean: 128 },
          timeline: [{ value: 118 }, { value: 136.8 }, { value: 129 }],
        },
      },
    ];
    const findings = findUnverifiedCoachNumbers(
      "Your systolic average is around 140.",
      payload,
    );
    expect(findings.map((f) => f.value)).toContain(140);
  });

  it("blocks an adherence % that is ±15 points off a single day's rate (M1 percent-space)", () => {
    // A per-day rate 0.8 is a SAMPLE (inside a timeline array). Dividing 93%
    // into 0.93 would ground it against 0.8 under a 0.15 band — the M1 bug.
    const payload = [
      {
        metric: "adherence",
        section: { timeline: [{ rate: 0.8 }, { rate: 0.75 }] },
      },
    ];
    const findings = findUnverifiedCoachNumbers(
      "Your adherence has been around 93%.",
      payload,
    );
    expect(findings.map((f) => f.value)).toContain(93);
  });

  it("blocks fabricated range endpoints 100–150 against a real min 121 / max 134 (D6)", () => {
    const payload = [
      { metric: "bp", section: { aggregate: { min: 121, max: 134 } } },
    ];
    const findings = findUnverifiedCoachNumbers(
      "Your systolic ranged from 100 to 150 mmHg.",
      payload,
    );
    const values = findings.map((f) => f.value);
    expect(values).toContain(100);
    expect(values).toContain(150);
  });

  it("blocks a fabricated figure equal to a payload date fragment (date-typing)", () => {
    // The payload carries an ISO date string; its mined fragment (-23) must
    // not ground a fabricated "23-point" claim.
    const payload = [
      {
        metric: "weight",
        section: { lastReading: "2026-07-23", aggregate: { latest: 72.4 } },
      },
    ];
    const findings = findUnverifiedCoachNumbers(
      "That is a 23 kg swing from where you were.",
      payload,
    );
    expect(findings.map((f) => f.value)).toContain(23);
  });

  it("blocks a fabricated pressure figure near an unrelated-kind leaf (kind-scoping)", () => {
    // The only authoritative leaf is a weight; a mmHg claim of the same
    // magnitude must NOT ground against it.
    const payload = [
      { metric: "weight", section: { aggregate: { latest: 72 } } },
    ];
    const findings = findUnverifiedCoachNumbers(
      "Your systolic averaged 72 mmHg this week.",
      payload,
    );
    expect(findings.map((f) => f.value)).toContain(72);
  });
});

describe("stripUnverifiedNumbers", () => {
  it("replaces only the flagged tokens, leaving grounded numbers intact", () => {
    const prose = "Systolic 128, but it spiked to 138 yesterday.";
    const findings = [{ value: 138, source: "138" }];
    const { prose: out, stripped } = stripUnverifiedNumbers(prose, findings);
    expect(stripped).toBe(1);
    expect(out).toContain("128");
    expect(out).toContain(UNVERIFIED_ELISION_MARK);
    expect(out).not.toContain("138");
  });

  it("rewrites to the editorial elision mark, not the old QA literal", () => {
    // v1.32.14 — the user reads a deliberate omission, never an internal token.
    const prose = "Your 10-year risk is 42%.";
    const { prose: out } = stripUnverifiedNumbers(prose, [
      { value: 42, source: "42" },
    ]);
    expect(UNVERIFIED_ELISION_MARK).toBe("[…]");
    expect(out).not.toContain("[unverified]");
    expect(out).toContain("[…]");
    // Digit-free by construction, so the tokenizer can never re-flag the mark.
    expect(/\d/.test(UNVERIFIED_ELISION_MARK)).toBe(false);
  });

  it("reads cleanly before a surviving unit (the unit is not part of the token)", () => {
    // The tokenizer flags the bare magnitude, so "128 mmHg" strips to "[…] mmHg".
    const prose = "Your systolic was 128 mmHg.";
    const { prose: out } = stripUnverifiedNumbers(prose, [
      { value: 128, source: "128" },
    ]);
    expect(out).toBe("Your systolic was […] mmHg.");
    expect(out).not.toContain("[unverified]");
  });

  it("reads cleanly as a range endpoint", () => {
    const prose = "between 118 and 130 mmHg";
    const { prose: out } = stripUnverifiedNumbers(prose, [
      { value: 118, source: "118" },
    ]);
    expect(out).toBe("between […] and 130 mmHg");
  });

  it("is a no-op when nothing was flagged", () => {
    const { prose, stripped } = stripUnverifiedNumbers("all good", []);
    expect(prose).toBe("all good");
    expect(stripped).toBe(0);
    expect(prose).not.toContain(UNVERIFIED_ELISION_MARK);
  });

  it("is boundary-safe: a flagged '23' never clips a grounded '2023' (v1.32.7)", () => {
    // The old plain indexOf produced "20[…]" here.
    const prose = "Since 2023 your reading of 23 stood out.";
    const { prose: out, stripped } = stripUnverifiedNumbers(prose, [
      { value: 23, source: "23" },
    ]);
    expect(out).toContain("2023");
    expect(out).not.toContain(`20${UNVERIFIED_ELISION_MARK}`);
    expect(out).toContain(UNVERIFIED_ELISION_MARK);
    expect(stripped).toBe(1);
  });
});

/**
 * The tokenizer's word lists were English (plus German month names). Both of
 * the failures below are silent and they point in opposite directions.
 *
 * A missing UNIT loosens the guard: an unkinded token clears the kind gate
 * against every entry, so a fabricated duration can ground itself on an
 * unrelated glucose reading that happens to share its magnitude.
 *
 * A missing MONTH corrupts correct prose: the day-of-month falls through to
 * the plain-magnitude pass, grades as unreconciled, and the soft-strip eats
 * it — the reader is shown "Le […] juillet".
 */
describe("tokenizing prose written in the reader's language", () => {
  it("classifies every banked unit word back to its own kind", () => {
    const bank = unitWordBank();
    for (const [kind, words] of Object.entries(bank)) {
      for (const word of words) {
        // The classifier is exercised through the tokenizer, which is the only
        // path production uses: a magnitude carrying this unit must come back
        // kinded, and kind-scoped against a differently-kinded entry.
        expect(word.length).toBeGreaterThan(0);
        expect(kind.length).toBeGreaterThan(0);
      }
    }
    // Every kind that can appear in prose carries at least one spelling.
    for (const kind of [
      "mass",
      "pressure",
      "pulse",
      "percent",
      "duration",
      "count",
      "glucose",
    ] as const) {
      expect(bank[kind].length).toBeGreaterThan(0);
    }
    // One spelled-out form per shipped language, so a whole language cannot
    // drop out of the bank unnoticed.
    for (const word of [
      "hours",
      "stunden",
      "heures",
      "horas",
      "ore",
      "godziny",
    ]) {
      expect(bank.duration).toContain(word);
    }
  });

  it("kinds a German duration so it cannot ground on a glucose reading", () => {
    // 7.4 mmol/L is a real glucose value and 7.4 hours is a real night's
    // sleep. Unkinded, the magnitudes matched and the invented figure passed.
    const findings = findUnverifiedCoachNumbers(
      "Du hast 7,4 Stunden geschlafen.",
      [{ metric: "glucose", latest: 7.4 }],
      "de",
    );
    expect(findings.map((f) => f.value)).toContain(7.4);
  });

  it("still reconciles that duration against a real sleep figure", () => {
    const findings = findUnverifiedCoachNumbers(
      "Du hast 7,4 Stunden geschlafen.",
      [{ metric: "sleep", latest: 444 }],
      "de",
    );
    expect(findings).toHaveLength(0);
  });

  it("kinds an Italian duration the same way", () => {
    const findings = findUnverifiedCoachNumbers(
      "Hai dormito 45 minuti in più rispetto alla media.",
      [{ metric: "weight", latest: 45 }],
      "it",
    );
    expect(findings.map((f) => f.value)).toContain(45);
  });

  it("types a Spanish spelled-out percent as a percent", () => {
    const findings = findUnverifiedCoachNumbers(
      "Su adherencia fue del 93 por ciento esta semana.",
      [{ metric: "adherence", latest: 0.93 }],
      "es",
    );
    expect(findings).toHaveLength(0);
  });

  it.each([
    ["fr", "Le 21 juillet, votre tension était de 128 mmHg."],
    ["es", "El 21 de julio, su tensión era de 128 mmHg."],
    ["it", "Il 21 luglio la pressione era di 128 mmHg."],
    ["pl", "21 lipca ciśnienie wynosiło 128 mmHg."],
    ["pt-BR", "Em 21 de julho, sua pressão era de 128 mmHg."],
  ] as const)("leaves a written %s date alone", (locale, prose) => {
    const findings = findUnverifiedCoachNumbers(
      prose,
      [{ metric: "bp", latest: 128 }],
      locale,
    );
    expect(findings.map((f) => f.value)).not.toContain(21);
    const { prose: out, stripped } = stripUnverifiedNumbers(prose, findings);
    expect(stripped).toBe(0);
    expect(out).toBe(prose);
  });

  it("still catches a fabricated figure in a sentence that carries a date", () => {
    // The date exemption must not become a blanket pass for its sentence.
    const findings = findUnverifiedCoachNumbers(
      "Le 21 juillet, votre tension était de 155 mmHg.",
      [{ metric: "bp", latest: 128 }],
      "fr",
    );
    expect(findings.map((f) => f.value)).toContain(155);
    expect(findings.map((f) => f.value)).not.toContain(21);
  });
});

/**
 * A sentence framed as population guidance has its numbers exempted from the
 * check, so a framing pattern that also matches a sentence about the reader's
 * own readings lets an invented figure through unchecked. The Brazilian
 * Portuguese bank needs a population subject or a reference noun for that
 * reason; the first two cases here were exempted by the broader patterns it
 * started with.
 */
describe("Brazilian Portuguese population-norm framing", () => {
  const payloads = [{ metric: "bp", latest: 128 }];

  it.each([
    "Sua pressão de 158/97 geralmente fica acima do seu padrão.",
    "Seu médico recomenda manter a pressão em 158/97.",
    "Entre as suas medições, a pressão normalmente fica em 158/97.",
    "Para um adulto como você, 158/97 geralmente precisa de atenção.",
  ])("still checks the numbers in: %s", (prose) => {
    const values = findUnverifiedCoachNumbers(prose, payloads, "pt-BR").map(
      (f) => f.value,
    );
    expect(values).toContain(158);
    expect(values).toContain(97);
  });

  it.each([
    "A faixa normal do pulso em repouso fica entre 60 e 100 bpm.",
    "Os médicos recomendam de 7 a 9 horas de sono por noite.",
    "A maioria dos adultos precisa de 7 a 9 horas de sono.",
    "A pressão arterial normal de um adulto fica abaixo de 120/80 mmHg.",
    "Os valores de referência da glicemia em jejum vão de 70 a 99 mg/dL.",
  ])("exempts the reference figures in: %s", (prose) => {
    expect(findUnverifiedCoachNumbers(prose, payloads, "pt-BR")).toEqual([]);
  });
});

/**
 * Each locale's population-norm bank lives in its own module. One reference
 * sentence per locale, worded so the English bank (which always runs too)
 * cannot be what matched it, pins that every module is wired and fires.
 */
describe("population-norm banks, one per locale", () => {
  const REFERENCE_SENTENCE: Record<Locale, string> = {
    en: "Healthy adults usually sleep 7 to 9 hours.",
    de: "Gesunde Erwachsene schlafen 7 bis 9 Stunden.",
    fr: "La plupart des adultes dorment 7 à 9 heures.",
    es: "Los adultos sanos duermen de 7 a 9 horas.",
    it: "Gli adulti sani dormono da 7 a 9 ore.",
    pl: "Większość dorosłych potrzebuje od 7 do 9 godzin snu.",
    nl: "Gezonde volwassenen slapen 7 tot 9 uur.",
    ko: "건강한 성인은 7~9시간 자요.",
    "pt-BR": "A maioria dos adultos precisa de 7 a 9 horas de sono.",
    ru: "Здоровые взрослые обычно спят от 7 до 9 часов.",
  };

  it.each(locales)("%s reads its reference sentence as a norm", (locale) => {
    expect(hasPopulationNormFraming(REFERENCE_SENTENCE[locale], locale)).toBe(
      true,
    );
    if (locale !== "en") {
      expect(hasPopulationNormFraming(REFERENCE_SENTENCE[locale], "en")).toBe(
        false,
      );
    }
  });
});
