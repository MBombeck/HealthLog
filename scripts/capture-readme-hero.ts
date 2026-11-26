/**
 * Films the animation at the top of README.md from a running instance.
 *
 * The animation is a handful of still scenes joined by slow crossfades, not a
 * screen recording: a recording catches skeletons, half-drawn charts and
 * scroll jank, and a still taken after the page has settled does not. Each
 * scene is captured at a desktop window of 1440 x 900 CSS pixels at device
 * pixel ratio 2 and scaled down by exactly half, so the text stays sharp and
 * the frame shows as much of the app as a real window does.
 *
 * Usage (see docs/contributing/readme-media.md for the whole procedure):
 *
 *   pnpm dlx tsx scripts/capture-readme-hero.ts [--base-url URL]
 *     [--themes light,dark] [--sidebar collapsed|expanded|both]
 *     [--out DIR] [--work DIR] [--only-stills]
 *
 * The instance must hold the demo seed (`scripts/seed-demo.ts`) and must not
 * run with DEMO_MODE, whose banner and write block are not part of the app.
 * The demo credentials are the public ones the seed writes.
 *
 * Needs Chromium for Playwright, ffmpeg (libx264, libvpx-vp9) and img2webp
 * (libwebp) on PATH.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

type Theme = "light" | "dark";
type SidebarMode = "collapsed" | "expanded";

interface Scene {
  id: string;
  /** Path to open first. */
  path: string;
  /** Selectors that must be visible before the frame is taken. */
  ready: string[];
  /** Optional steps after the page settled (open a tab, pick a record). */
  prepare?: (page: Page, baseUrl: string) => Promise<void>;
  /** How long the scene stands still in the animation, in milliseconds. */
  holdMs: number;
}

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const DPR = 2;
const FADE_MS = 800;
const FADE_FRAMES = 8;
const WEBP_BUDGET_BYTES = 4 * 1024 * 1024;
const SIDEBAR_KEY = "healthlog-sidebar-collapsed";
const DEMO_USER = "demo";
const DEMO_PASSWORD = "demo123demo123";

/**
 * Everything that changes between two identical renders, or that a visitor
 * would never see in a still: scrollbars, the pointer, the text caret, toasts
 * and every transition.
 */
const STILL_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  caret-color: transparent !important;
  cursor: none !important;
  scrollbar-width: none !important;
}
::-webkit-scrollbar { display: none !important; }
[data-sonner-toaster], [data-slot="demo-banner"] { display: none !important; }
`;

const BUSY_SELECTOR = [
  '[data-slot="skeleton"]',
  ".animate-pulse",
  '[aria-busy="true"]',
].join(", ");

const SCENES: Scene[] = [
  {
    id: "home",
    path: "/",
    ready: ["main h1", ".recharts-surface"],
    holdMs: 3600,
  },
  {
    id: "insights",
    path: "/insights/blood-pressure",
    ready: ["main h1", ".recharts-surface"],
    holdMs: 3000,
  },
  {
    id: "medication",
    path: "/medications",
    ready: ["main h1"],
    // Opens the medication whose next dose comes first, so the detail page
    // shows a dose with its window rather than a finished day.
    prepare: async (page, baseUrl) => {
      const href = await page
        .locator('main a[href^="/medications/c"]')
        .first()
        .getAttribute("href");
      if (!href) throw new Error("no medication to open");
      await page.goto(baseUrl + href);
      await settle(page, ["main h1"]);
    },
    holdMs: 3000,
  },
  {
    id: "emergency",
    path: "/emergency-card",
    ready: ["main h1"],
    holdMs: 3000,
  },
];

const END_CARD_HOLD_MS = 3600;

// ---------------------------------------------------------------------------

interface Options {
  baseUrl: string;
  themes: Theme[];
  sidebar: SidebarMode[];
  out: string;
  work: string;
  onlyStills: boolean;
}

function parseArgs(argv: string[]): Options {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const sidebarArg = get("sidebar") ?? "collapsed";
  return {
    baseUrl: (get("base-url") ?? "http://localhost:3000").replace(/\/$/, ""),
    themes: (get("themes") ?? "light,dark").split(",") as Theme[],
    sidebar:
      sidebarArg === "both"
        ? ["collapsed", "expanded"]
        : [sidebarArg as SidebarMode],
    out: resolve(get("out") ?? "docs/assets"),
    work: resolve(get("work") ?? join(tmpdir(), "healthlog-readme-hero")),
    onlyStills: argv.includes("--only-stills"),
  };
}

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: ["ignore", "ignore", "inherit"] });
}

async function login(browser: Browser, baseUrl: string, statePath: string) {
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/auth/login`);
  const passwordToggle = page.getByText("Sign in with password");
  if (await passwordToggle.isVisible().catch(() => false)) {
    await passwordToggle.click();
  }
  await page.locator("input:not([type=password])").first().fill(DEMO_USER);
  await page.locator("input[type=password]").fill(DEMO_PASSWORD);
  await page.locator("input[type=password]").press("Enter");
  await page.waitForURL((url) => !url.pathname.startsWith("/auth"), {
    timeout: 30_000,
  });
  await context.storageState({ path: statePath });
  await context.close();
}

async function newSceneContext(
  browser: Browser,
  statePath: string,
  theme: Theme,
  viewport: { width: number; height: number },
  sidebar: SidebarMode,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    storageState: statePath,
    viewport,
    deviceScaleFactor: viewport === PHONE ? 3 : DPR,
    colorScheme: theme,
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "Europe/Berlin",
  });
  await context.addInitScript(
    ([key, collapsed]) => {
      try {
        localStorage.setItem(key, collapsed);
      } catch {
        // A blocked storage only means the default sidebar width.
      }
    },
    [SIDEBAR_KEY, String(sidebar === "collapsed")] as const,
  );
  return context;
}

/**
 * Waits until the page is the page: requests done, fonts loaded, no skeleton
 * or busy region left, every ready selector visible, and two screenshots in a
 * row identical. The last condition is the one that catches a chart still
 * laying out or a late query re-rendering a card.
 */
async function settle(page: Page, ready: string[]): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.addStyleTag({ content: STILL_CSS });
  await page.evaluate(() => document.fonts.ready);
  for (const selector of ready) {
    await page.locator(selector).first().waitFor({ state: "visible" });
  }
  await page.waitForFunction(
    (busy) => document.querySelectorAll(busy).length === 0,
    BUSY_SELECTOR,
    { timeout: 20_000 },
  );
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  let previous = "";
  for (let attempt = 0; attempt < 12; attempt++) {
    await page.waitForTimeout(400);
    const digest = createHash("sha256")
      .update(await page.screenshot())
      .digest("hex");
    if (digest === previous) return;
    previous = digest;
  }
  throw new Error(`${page.url()} never stopped changing`);
}

async function captureScene(
  context: BrowserContext,
  baseUrl: string,
  scene: Scene,
  file: string,
): Promise<void> {
  const page = await context.newPage();
  await page.goto(baseUrl + scene.path);
  if (new URL(page.url()).pathname.startsWith("/auth")) {
    throw new Error("the session expired; delete the work dir and rerun");
  }
  await settle(page, scene.ready);
  if (scene.prepare) {
    await scene.prepare(page, baseUrl);
    await settle(page, scene.ready);
  }
  await page.screenshot({ path: file });
  await page.close();
}

/**
 * The last scene: the desktop home beside the phone home, laid out by the
 * browser itself so the corners, the shadow and the spacing come from CSS
 * rather than a filter graph.
 */
async function composeEndCard(
  browser: Browser,
  theme: Theme,
  desktopPng: string,
  phonePng: string,
  file: string,
): Promise<void> {
  const background = theme === "dark" ? "#0b0b0f" : "#f4f4f6";
  const shadow =
    theme === "dark"
      ? "0 24px 64px rgba(0,0,0,.6)"
      : "0 24px 64px rgba(24,24,40,.18)";
  const data = (path: string) =>
    `data:image/png;base64,${readFileSync(path).toString("base64")}`;
  const html = `<!doctype html><html><body style="margin:0;width:${DESKTOP.width}px;height:${DESKTOP.height}px;background:${background};display:flex;align-items:center;justify-content:center;gap:56px">
<img src="${data(desktopPng)}" style="width:960px;border-radius:14px;box-shadow:${shadow}">
<img src="${data(phonePng)}" style="height:700px;border-radius:36px;box-shadow:${shadow}">
</body></html>`;
  const context = await browser.newContext({
    viewport: DESKTOP,
    deviceScaleFactor: DPR,
  });
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: "load" });
  await page.screenshot({ path: file });
  await context.close();
}

/** Scales a DPR-2 still to the asset size: exactly half, Lanczos. */
function downscale(src: string, dest: string): void {
  run("ffmpeg", [
    "-loglevel",
    "error",
    "-y",
    "-i",
    src,
    "-vf",
    `scale=${DESKTOP.width}:${DESKTOP.height}:flags=lanczos`,
    dest,
  ]);
}

function crossfadeFrame(a: string, b: string, t: number, dest: string): void {
  // Ease in and out, so the fade starts and ends without a jolt.
  const mix = ((1 - Math.cos(Math.PI * t)) / 2).toFixed(4);
  run("ffmpeg", [
    "-loglevel",
    "error",
    "-y",
    "-i",
    a,
    "-i",
    b,
    "-filter_complex",
    `[0][1]blend=all_expr='A*(1-${mix})+B*${mix}'`,
    dest,
  ]);
}

function encodeWebp(
  stills: string[],
  holds: number[],
  dir: string,
  dest: string,
) {
  const frameMs = Math.round(FADE_MS / FADE_FRAMES);
  const args: string[] = [];
  stills.forEach((still, i) => {
    const next = stills[(i + 1) % stills.length];
    args.push("-d", String(holds[i]), still);
    for (let f = 1; f < FADE_FRAMES; f++) {
      const frame = join(dir, `fade-${i}-${f}.png`);
      crossfadeFrame(still, next, f / FADE_FRAMES, frame);
      args.push("-d", String(frameMs), frame);
    }
  });
  // Step the quality down until the file fits the budget.
  for (const q of [82, 76, 70, 64]) {
    run("img2webp", [
      "-loop",
      "0",
      "-lossy",
      "-q",
      String(q),
      "-m",
      "6",
      ...args,
      "-o",
      dest,
    ]);
    const size = statSync(dest).size;
    console.log(`  ${dest}: q${q}, ${(size / 1024 / 1024).toFixed(2)} MB`);
    if (size <= WEBP_BUDGET_BYTES) return;
  }
  throw new Error(`${dest} stays above the size budget`);
}

function encodeVideos(stills: string[], holds: number[], base: string) {
  const fade = FADE_MS / 1000;
  const inputs: string[] = [];
  stills.forEach((still, i) => {
    inputs.push(
      "-loop",
      "1",
      "-t",
      String(holds[i] / 1000 + fade),
      "-i",
      still,
    );
  });
  // Chain xfade. Every clip lasts its hold plus one fade, and the fades
  // overlap, so fade i starts at the sum of the holds before it.
  let graph = "";
  let label = "[0:v]";
  let offset = 0;
  for (let i = 1; i < stills.length; i++) {
    offset += holds[i - 1] / 1000;
    const out = i === stills.length - 1 ? "[v]" : `[x${i}]`;
    graph += `${label}[${i}:v]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(3)}${out};`;
    label = out;
  }
  graph += "[v]format=yuv420p,fps=30[o]";
  const common = [
    "-loglevel",
    "error",
    "-y",
    ...inputs,
    "-filter_complex",
    graph,
    "-map",
    "[o]",
  ];
  run("ffmpeg", [
    ...common,
    "-c:v",
    "libx264",
    "-crf",
    "20",
    "-preset",
    "slow",
    "-movflags",
    "+faststart",
    `${base}.mp4`,
  ]);
  run("ffmpeg", [
    ...common,
    "-c:v",
    "libvpx-vp9",
    "-crf",
    "32",
    "-b:v",
    "0",
    "-row-mt",
    "1",
    `${base}.webm`,
  ]);
  for (const ext of ["mp4", "webm"]) {
    console.log(
      `  ${base}.${ext}: ${(statSync(`${base}.${ext}`).size / 1024 / 1024).toFixed(2)} MB`,
    );
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(opts.work, { recursive: true });
  mkdirSync(opts.out, { recursive: true });
  const statePath = join(opts.work, "state.json");

  const browser = await chromium.launch();
  try {
    await login(browser, opts.baseUrl, statePath);

    for (const theme of opts.themes) {
      for (const sidebar of opts.sidebar) {
        const tag = `${theme}-${sidebar}`;
        const dir = join(opts.work, tag);
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        console.log(`capturing ${tag}`);

        const desktop = await newSceneContext(
          browser,
          statePath,
          theme,
          DESKTOP,
          sidebar,
        );
        const raws: string[] = [];
        for (const scene of SCENES) {
          const raw = join(dir, `${scene.id}@2x.png`);
          await captureScene(desktop, opts.baseUrl, scene, raw);
          raws.push(raw);
        }
        await desktop.close();

        const phone = await newSceneContext(
          browser,
          statePath,
          theme,
          PHONE,
          sidebar,
        );
        const phoneRaw = join(dir, "phone@3x.png");
        await captureScene(phone, opts.baseUrl, SCENES[0], phoneRaw);
        await phone.close();
        const endRaw = join(dir, "end@2x.png");
        await composeEndCard(browser, theme, raws[0], phoneRaw, endRaw);
        raws.push(endRaw);

        const stills = raws.map((raw) => {
          const still = raw.replace(/@2x\.png$/, ".png");
          downscale(raw, still);
          return still;
        });
        if (opts.onlyStills) continue;

        const holds = [...SCENES.map((s) => s.holdMs), END_CARD_HOLD_MS];
        const name = `readme-hero-${theme}`;
        const suffix = opts.sidebar.length > 1 ? `-${sidebar}` : "";
        encodeWebp(stills, holds, dir, join(opts.out, `${name}${suffix}.webp`));
        encodeVideos(stills, holds, join(opts.work, `${name}${suffix}`));
      }
    }
  } finally {
    await browser.close();
  }
  writeFileSync(join(opts.work, "DONE"), new Date().toISOString());
  console.log(
    `stills and videos in ${opts.work}, README assets in ${opts.out}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
