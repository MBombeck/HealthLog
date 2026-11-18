/**
 * v1.18.7 — static catalog of the public /learn guides for the Coach.
 *
 * The Coach is article-aware: when a reply would genuinely benefit from a
 * deeper read, it MAY point the user at the matching guide by topic + URL.
 * The article wording itself lives on the public site (docs.healthlog.dev /
 * healthlog.dev/learn) — the Coach never invents article content and may only
 * reference a slug that appears in this catalog, so a fabricated /learn URL is
 * impossible by construction.
 *
 * Keep this list in lock-step with the published guides. The compact prompt
 * injection (`learnCatalogPromptBlock`) groups entries by topic so the model
 * picks the most relevant single link rather than dumping the whole list.
 */

const LEARN_BASE_URL = "https://healthlog.dev/learn";

export interface LearnGuide {
  /** URL slug under /learn. */
  slug: string;
  /** Concise English title. */
  title: string;
  /** 3–6 word topic the guide covers, for matching. */
  topic: string;
  /** Absolute public URL. */
  url: string;
}

function guide(slug: string, title: string, topic: string): LearnGuide {
  return { slug, title, topic, url: `${LEARN_BASE_URL}/${slug}` };
}

/**
 * The 19 published /learn guides. Order groups roughly by domain (overview →
 * cardiovascular → sleep/respiratory → metabolic → body → mood/cycle →
 * device/trends → lifestyle) so the prompt block reads coherently.
 */
export const LEARN_GUIDES: readonly LearnGuide[] = [
  guide(
    "understanding-your-health-metrics",
    "Understanding Your Health Metrics",
    "what each metric means",
  ),
  guide("resting-heart-rate", "Resting Heart Rate", "resting heart rate"),
  guide(
    "heart-rate-variability",
    "Heart Rate Variability",
    "HRV and autonomic balance",
  ),
  guide(
    "reading-your-blood-pressure",
    "Reading Your Blood Pressure",
    "blood pressure readings",
  ),
  guide("sleep-consistency", "Sleep Consistency", "consistent sleep timing"),
  guide("respiratory-rate", "Respiratory Rate", "breathing rate at rest"),
  guide("blood-oxygen-spo2", "Blood Oxygen (SpO2)", "blood oxygen saturation"),
  guide(
    "body-temperature-baseline",
    "Body Temperature Baseline",
    "body temperature deviation",
  ),
  guide(
    "blood-sugar-beyond-diabetes",
    "Blood Sugar Beyond Diabetes",
    "glucose for everyone",
  ),
  guide(
    "vo2max-and-longevity",
    "VO2 Max and Longevity",
    "cardiorespiratory fitness",
  ),
  guide("beyond-the-scale", "Beyond the Scale", "weight and body composition"),
  guide("tracking-mood", "Tracking Mood", "mood and wellbeing"),
  guide(
    "the-cycle-as-a-vital-sign",
    "The Cycle as a Vital Sign",
    "menstrual cycle health",
  ),
  guide(
    "how-wearables-measure-you",
    "How Wearables Measure You",
    "how devices read vitals",
  ),
  guide("reading-your-trends", "Reading Your Trends", "interpreting trends"),
  guide("steps-and-movement", "Steps and Movement", "daily activity"),
  guide(
    "caffeine-alcohol-and-your-readings",
    "Caffeine, Alcohol and Your Readings",
    "caffeine and alcohol effects",
  ),
  guide("hydration-and-your-body", "Hydration and Your Body", "hydration"),
  guide("stress-and-recovery", "Stress and Recovery", "stress and recovery"),
] as const;

/**
 * Compact, token-light prompt block listing every guide as `topic — url`.
 * Injected into the Coach system prompt so the model can offer the relevant
 * link. One line per guide keeps it ~600 chars; the model picks at most one.
 */
export function learnCatalogPromptBlock(): string {
  const lines = LEARN_GUIDES.map((g) => `- ${g.topic}: ${g.url}`).join("\n");
  // Look the example guide up by slug, not by array index, so reordering the
  // catalog above cannot silently change the prompt example.
  const exampleGuide =
    LEARN_GUIDES.find((g) => g.slug === "resting-heart-rate") ??
    LEARN_GUIDES[0];
  return [
    "LEARN GUIDES (public articles you MAY link when genuinely helpful):",
    lines,
    "Only link a URL from this list — never invent a learn-guide URL or article",
    "content. Reference at most one guide, and only when it adds real value,",
    'e.g. "more on this: ' + exampleGuide.url + '".',
  ].join("\n");
}
