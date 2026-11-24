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
 *     in white on the pass colour, square, no rounding (Wallet rounds it);
 *   - logo, primaryLogo: the mark alone on transparency, cropped tight (the
 *     Watch trims white space, so the images carry none);
 *   - artwork: the poster background. A quiet diagonal from deep red to
 *     plum, a soft light from the top left, one fine pulse line at 38 %
 *     height at 8 % opacity, and a sparse grain against banding. No text,
 *     no logo, nothing that matters in the lower 40 %, where Wallet lays the
 *     material strip with the QR code.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

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
/** The heart's bounds in the 24-unit box, stroke included. */
const MARK_BOX = { x: 1.4, y: 2.4, w: 21.2, h: 19.55 };

const IMAGES = [
  { name: "icon.png", w: 38, h: 38, kind: "icon" },
  { name: "icon@2x.png", w: 76, h: 76, kind: "icon" },
  { name: "icon@3x.png", w: 114, h: 114, kind: "icon" },
  { name: "logo@2x.png", w: 100, h: 100, kind: "mark" },
  { name: "logo@3x.png", w: 150, h: 150, kind: "mark" },
  { name: "primaryLogo@2x.png", w: 60, h: 60, kind: "mark" },
  { name: "primaryLogo@3x.png", w: 90, h: 90, kind: "mark" },
  { name: "artwork@2x.png", w: 716, h: 896, kind: "artwork" },
  { name: "artwork@3x.png", w: 1074, h: 1344, kind: "artwork" },
];

/** Runs in the page: draw one image, return its RGBA pixels as base64. */
function draw({ w, h, kind, heart, pulse, box }) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { colorSpace: "srgb" });

  const mark = (size, cx, cy) => {
    // Fit the heart's bounds into a square of `size`, centred on cx, cy.
    const s = size / Math.max(box.w, box.h);
    ctx.save();
    ctx.translate(cx - (box.x + box.w / 2) * s, cy - (box.y + box.h / 2) * s);
    ctx.scale(s, s);
    const path = new Path2D(heart);
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.fill(path);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.3;
    ctx.stroke(path);
    ctx.clip(path);
    ctx.beginPath();
    pulse.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();
  };

  if (kind === "icon") {
    ctx.fillStyle = "rgb(122, 22, 44)";
    ctx.fillRect(0, 0, w, h);
    mark(w * 0.66, w / 2, h / 2 + h * 0.02);
  } else if (kind === "mark") {
    mark(w, w / 2, h / 2);
  } else {
    // Only the pulse line is drawn here, opaque on transparency; the
    // background is computed in Node (`artwork` below), because the
    // canvas dithers gradients, and dither noise costs several hundred
    // kilobytes of PNG that the pass size budget does not have.
    const y0 = h * 0.38;
    const unit = w / 34;
    const beatX = w * 0.8;
    const beat = [
      [-2.2, 0],
      [-1.2, -1.4],
      [0, 3.0],
      [1.2, -4.2],
      [2.4, 0],
    ];
    ctx.beginPath();
    ctx.moveTo(0, y0);
    for (const [dx, dy] of beat) ctx.lineTo(beatX + dx * unit, y0 + dy * unit);
    ctx.lineTo(w, y0);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = w / 358;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
  }
  const data = ctx.getImageData(0, 0, w, h).data;
  let bin = "";
  for (let i = 0; i < data.length; i += 0x8000) {
    bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** A small, seeded generator, so the grain is the same on every run. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sparse monochrome grain: one pixel in a hundred moves one level up or
 * down. Enough to break the steps of a dark 8-bit gradient; denser grain is
 * noise to the PNG encoder and costs more than the pass size budget allows.
 */
function grain(rgba, seed) {
  const rand = mulberry32(seed);
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rand();
    if (r >= 0.01) continue;
    const d = r < 0.005 ? -1 : 1;
    for (let c = 0; c < 3; c++) {
      rgba[i + c] = Math.max(0, Math.min(255, rgba[i + c] + d));
    }
  }
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const TOP_LEFT = hex("#8E1B2B");
const BOTTOM_RIGHT = hex("#3B0F3F");
const GLOW = [255, 170, 150];
const GLOW_ALPHA = 0.16;
const PULSE_ALPHA = 0.08;

/**
 * The poster background under the pulse line `line` (RGBA, line in alpha):
 * the diagonal, the glow from the top left, the line, all in sRGB with
 * source-over, rounded once at the end. Written into `line` in place.
 */
function artwork(line, w, h) {
  const len2 = w * w + h * h;
  const gx = w * 0.18;
  const gy = h * 0.08;
  const gr = w * 0.95;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const t = Math.min(1, Math.max(0, (x * w + y * h) / len2));
      const d = Math.hypot(x + 0.5 - gx, y + 0.5 - gy) / gr;
      const ga = GLOW_ALPHA * Math.max(0, 1 - d);
      const la = (line[i + 3] / 255) * PULSE_ALPHA;
      for (let c = 0; c < 3; c++) {
        let v = TOP_LEFT[c] + (BOTTOM_RIGHT[c] - TOP_LEFT[c]) * t;
        v = v * (1 - ga) + GLOW[c] * ga;
        v = v * (1 - la) + 255 * la;
        line[i + c] = Math.round(v);
      }
      line[i + 3] = 255;
    }
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
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
    });
    const rgba = Buffer.from(b64, "base64");
    if (img.kind === "artwork") {
      artwork(rgba, img.w, img.h);
      grain(rgba, img.w * 7919 + img.h);
    }
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
    join(OUT, "wallet-assets.v1.json"),
    `${JSON.stringify(hashes, null, 2)}\n`,
  );
  console.log(`total ${total} bytes`);
}

await main();
