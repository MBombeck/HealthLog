#!/usr/bin/env node
/**
 * Draw the images of the emergency-card Wallet pass and write their pinned
 * hash list (`src/lib/emergency-card/wallet-pass/assets/`).
 *
 *   node scripts/wallet/generate-pass-assets.mjs
 *
 * The PNGs are committed and are the source of truth: the project's signing
 * service pins their SHA-1, so a run that changes a byte means a new
 * `wallet-assets.v<n>.json` and a new signing-service release, never a quiet
 * replacement. This script exists so the files can be made again on purpose
 * and reviewed, not so they are rebuilt on every change.
 *
 * Drawn in Chromium's canvas (the Playwright browser the e2e suite already
 * installs) and encoded here: the pixels come back from the page and are
 * written as PNG with the best per-row filter and zlib level 9, with an sRGB
 * chunk and nothing else, so the bytes depend only on the pixels.
 *
 *   - icon: the HealthLog mark (heart and pulse line, `public/favicon.svg`)
 *     filled white on the pass red, the pulse line cut out of it, so it reads
 *     at 38 pt; square, no rounding (Wallet rounds it);
 *   - logo, primaryLogo: the mark alone on transparency, cropped tight to
 *     its own proportions (the Watch trims white space, so the images carry
 *     none), with a heavier line than the favicon for its small size;
 *   - artwork: the poster background (wallet-design v2, §5.2). One red hue
 *     from light at the top to dark under the strip, a soft light behind the
 *     mark, five faint rings around it, the mark itself as the one subject
 *     in the free upper half, and a darker band behind the logo row. No
 *     text, nothing that matters below 245 pt, where Wallet lays the QR code
 *     and the material strip. The tones are computed here, not in the
 *     canvas: the canvas dithers gradients with noise, and noise costs the
 *     PNG several hundred kilobytes the pass size budget does not have. A
 *     4 x 4 ordered dither was tried as well; it cost 60 % more bytes and
 *     removed no banding visible even at quadrupled contrast.
 *
 * The output file names the hash list's version; a new design is a new
 * version, never an edit of an old list.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "src/lib/emergency-card/wallet-pass/assets");

const HEART =
  "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z";
const PULSE = [
  [3, 12.5],
  [8, 12.5],
  [9.5, 9],
  [11, 16],
  [12.5, 7],
  [14, 12.5],
  [15.5, 12.5],
  [21, 12.5],
];
/** The mark's line widths in the 24-unit box: heavier than the favicon. */
const MARK_STROKE = 1.6;
const MARK_PULSE = 2.0;
/**
 * The heart's bounds in the 24-unit box, stroke included, with a sliver
 * more so the anti-aliased edge of the line is not cut.
 */
const EDGE = MARK_STROKE / 2 + 0.15;
const MARK_BOX = {
  x: 2 - EDGE,
  y: 3 - EDGE,
  w: 20 + 2 * EDGE,
  h: 18.35 + 2 * EDGE,
};
const MARK_RATIO = MARK_BOX.w / MARK_BOX.h;
const markWidth = (h) => Math.round(h * MARK_RATIO);

/** The hash list this run writes. */
const VERSION = 2;

const IMAGES = [
  { name: "icon.png", w: 38, h: 38, kind: "icon" },
  { name: "icon@2x.png", w: 76, h: 76, kind: "icon" },
  { name: "icon@3x.png", w: 114, h: 114, kind: "icon" },
  { name: "logo@2x.png", w: markWidth(100), h: 100, kind: "mark" },
  { name: "logo@3x.png", w: markWidth(150), h: 150, kind: "mark" },
  { name: "primaryLogo@2x.png", w: markWidth(60), h: 60, kind: "mark" },
  { name: "primaryLogo@3x.png", w: markWidth(90), h: 90, kind: "mark" },
  { name: "artwork@2x.png", w: 716, h: 896, kind: "artwork" },
  { name: "artwork@3x.png", w: 1074, h: 1344, kind: "artwork" },
];

/** The artwork, in points (358 x 448): where the mark and its rings sit. */
const ART = {
  w: 358,
  h: 448,
  cx: 179,
  cy: 148,
  markWidth: 104,
  rings: [
    [60, 0.13],
    [92, 0.095],
    [128, 0.07],
    [168, 0.05],
    [212, 0.035],
  ],
};

/** Runs in the page: draw one image, return its RGBA pixels as base64. */
function draw({ w, h, kind, heart, pulse, box, stroke, pulseWidth, art, bg }) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { colorSpace: "srgb" });

  /** Map the 24-unit box so the heart's bounds are `width` wide at cx, cy. */
  const place = (width, cx, cy) => {
    const s = width / box.w;
    ctx.translate(cx - (box.x + box.w / 2) * s, cy - (box.y + box.h / 2) * s);
    ctx.scale(s, s);
    return s;
  };
  const pulseLine = () => {
    ctx.beginPath();
    pulse.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  };
  const path = new Path2D(heart);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  if (kind === "icon") {
    // Filled heart, the pulse cut out in the pass red.
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    place(w * 0.68, w / 2, h / 2 + h * 0.02);
    ctx.fillStyle = "#ffffff";
    ctx.fill(path);
    ctx.clip(path);
    pulseLine();
    ctx.strokeStyle = bg;
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ctx.restore();
  } else if (kind === "mark") {
    ctx.save();
    place(w, w / 2, h / 2);
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.fill(path);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = stroke;
    ctx.stroke(path);
    ctx.clip(path);
    pulseLine();
    ctx.lineWidth = pulseWidth;
    ctx.stroke();
    ctx.restore();
  } else {
    // Only what sits on the background is drawn here, on transparency: the
    // rings, the soft light in the shape of the heart, the mark. The
    // background itself is computed in Node (`artwork` below).
    const k = w / art.w;
    ctx.save();
    ctx.scale(k, k);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    for (const [r, a] of art.rings) {
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.arc(art.cx, art.cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.filter = `blur(${16 * k}px)`;
    ctx.globalAlpha = 0.35;
    place(art.markWidth * k, art.cx * k, art.cy * k);
    ctx.fillStyle = "#ffffff";
    ctx.fill(path);
    ctx.restore();

    ctx.save();
    const s = place(art.markWidth * k, art.cx * k, art.cy * k);
    ctx.fillStyle = "rgba(255,255,255,0.14)";
    ctx.fill(path);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = (2.4 * k) / s;
    ctx.stroke(path);
    ctx.clip(path);
    pulseLine();
    ctx.lineWidth = (3.4 * k) / s;
    ctx.stroke();
    ctx.restore();
  }
  const data = ctx.getImageData(0, 0, w, h).data;
  let bin = "";
  for (let i = 0; i < data.length; i += 0x8000) {
    bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** The pass red (backgroundColor), for the icon. */
const PASS_RED = "#8A0E24";
/** Top to bottom, at these fractions of the height. */
const STOPS = [
  [0, hex("#A51430")],
  [0.42, hex("#8A0E24")],
  [0.8, hex("#5E0918")],
  [1, hex("#4A0712")],
];
/** Light behind the mark: colour, radius in pt, alpha at its stops. */
const GLOSS = {
  rgb: hex("#FF4D66"),
  r: 175,
  stops: [
    [0, 0.42],
    [0.55, 0.12],
    [1, 0],
  ],
};
/** A darker band behind the logo row, so the header reads over the light. */
const SCRIM = { rgb: hex("#2A0008"), h: 72, alpha: 0.3 };

function ramp(stops, t) {
  for (let i = 1; i < stops.length; i++) {
    const [t1, v1] = stops[i];
    const [t0, v0] = stops[i - 1];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return Array.isArray(v0)
        ? v0.map((c, j) => c + (v1[j] - c) * f)
        : v0 + (v1 - v0) * f;
    }
  }
  return stops[stops.length - 1][1];
}

/**
 * The poster background under the overlay `top` (RGBA from the canvas), in
 * sRGB with source-over: the vertical ramp, the light behind the mark, the
 * band behind the header, then the overlay; rounded once.
 * Written into `top` in place.
 */
function artwork(top, w, h) {
  const k = w / ART.w;
  for (let y = 0; y < h; y++) {
    const base = ramp(STOPS, (y + 0.5) / h);
    const ypt = (y + 0.5) / k;
    const sa = ypt < SCRIM.h ? SCRIM.alpha * (1 - ypt / SCRIM.h) : 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const d = Math.hypot((x + 0.5) / k - ART.cx, ypt - ART.cy) / GLOSS.r;
      const ga = d < 1 ? ramp(GLOSS.stops, d) : 0;
      const oa = top[i + 3] / 255;
      for (let c = 0; c < 3; c++) {
        let v = base[c];
        v = v * (1 - ga) + GLOSS.rgb[c] * ga;
        v = v * (1 - sa) + SCRIM.rgb[c] * sa;
        // The canvas hands back un-premultiplied colour.
        v = v * (1 - oa) + top[i + c] * oa;
        top[i + c] = Math.max(0, Math.min(255, Math.round(v)));
      }
      top[i + 3] = 255;
    }
  }
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** PNG, 8-bit RGB or RGBA, the cheapest filter per row (sum of |residual|). */
function encodePng(rgba, w, h, alpha) {
  const bpp = alpha ? 4 : 3;
  const stride = w * bpp;
  const raw = Buffer.alloc((stride + 1) * h);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < bpp; c++)
        row[x * bpp + c] = rgba[(y * w + x) * 4 + c];
    }
    let best = null;
    let bestCost = Infinity;
    for (let f = 0; f < 5; f++) {
      const out = Buffer.alloc(stride);
      let cost = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? row[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][f];
        const v = (row[i] - pred) & 0xff;
        out[i] = v;
        cost += v < 128 ? v : 256 - v;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = [f, out];
      }
    }
    raw[y * (stride + 1)] = best[0];
    best[1].copy(raw, y * (stride + 1) + 1);
    prev = row;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("sRGB", Buffer.from([0])),
    chunk("IDAT", deflateSync(raw, { level: 9, memLevel: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent("<!doctype html><html><body></body></html>");
  const hashes = {};
  let total = 0;
  for (const img of IMAGES) {
    const b64 = await page.evaluate(draw, {
      ...img,
      heart: HEART,
      pulse: PULSE,
      box: MARK_BOX,
      stroke: MARK_STROKE,
      pulseWidth: MARK_PULSE,
      art: ART,
      bg: PASS_RED,
    });
    const rgba = Buffer.from(b64, "base64");
    if (img.kind === "artwork") artwork(rgba, img.w, img.h);
    const png = encodePng(rgba, img.w, img.h, img.kind === "mark");
    writeFileSync(join(OUT, img.name), png);
    hashes[img.name] = createHash("sha1").update(png).digest("hex");
    total += png.length;
    console.log(
      `${img.name.padEnd(22)} ${img.w}x${img.h}  ${png.length} bytes`,
    );
  }
  await browser.close();
  writeFileSync(
    join(OUT, `wallet-assets.v${VERSION}.json`),
    `${JSON.stringify(hashes, null, 2)}\n`,
  );
  console.log(`total ${total} bytes`);
}

await main();
