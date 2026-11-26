# README media

The animation at the top of `README.md` is made by one script,
`scripts/capture-readme-hero.ts`, from a local build with the demo seed. Nothing
in it is drawn or edited by hand, so it can be made again whenever the screens
it shows change.

## What it shows

Five still scenes, each held for about three seconds and joined by a slow
crossfade of 0.8 s, in a loop of about 20 s:

1. the home page: the score row, one row of tiles and a chart
2. blood pressure insights with its chart
3. a medication with its next dose
4. the emergency card
5. an end card with the home page on the desktop beside the phone view

Each desktop scene is a 1440 x 900 window at device pixel ratio 2 with the
sidebar collapsed, scaled down by exactly half to 1440 x 900. The phone view is
390 x 844 at ratio 3. The light and the dark theme are filmed separately and
the README picks one by the reader's colour scheme with `<picture>`.

Outputs:

| File                                   | Use                             |
| -------------------------------------- | ------------------------------- |
| `docs/assets/readme-hero-light.webp`   | README, light scheme (max 4 MB) |
| `docs/assets/readme-hero-dark.webp`    | README, dark scheme (max 4 MB)  |
| `<work>/readme-hero-{light,dark}.mp4`  | website and docs (H.264)        |
| `<work>/readme-hero-{light,dark}.webm` | website and docs (VP9)          |
| `<work>/<theme>-<sidebar>/*.png`       | the stills, for review          |

GitHub does not play a `<video>` from a file in the repository, so the README
uses the animated WebP. There is no GIF: 256 colours band the chart fills and
the card shadows, and every browser GitHub supports shows WebP.

## Making it

1. Start a throwaway Postgres and build the branch the README will describe:
   `pnpm build`, then `pnpm start` with `DATABASE_URL`, `ENCRYPTION_KEY`,
   `API_TOKEN_HMAC_KEY` and `SESSION_COOKIE_SECURE=false`. Do not set
   `DEMO_MODE`; its banner is not part of the app.
2. Seed the demo account: `pnpm dlx tsx scripts/seed-demo.ts` with the same
   `DATABASE_URL` and keys. The seed is fictional and relative to today.
3. Run `pnpm dlx tsx scripts/capture-readme-hero.ts --base-url http://localhost:3000`.
   `--sidebar both` films the collapsed and the expanded sidebar side by side
   for a comparison, `--only-stills` skips the encoding, `--themes light`
   films one theme.
4. Look at every still in the work directory before using the result. The
   script waits for requests, fonts, skeletons and charts, and takes a frame
   only once two screenshots in a row are identical, but it cannot tell a
   scene that shows the wrong thing.
5. Commit the two WebP files together with the README change. Remove the
   Postgres container afterwards.

Needs Chromium for Playwright (`pnpm dlx playwright install chromium`),
`ffmpeg` with libx264 and libvpx-vp9, and `img2webp` from libwebp.
