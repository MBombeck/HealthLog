/**
 * Which image line a build came from. Resolved once on the server and
 * published on `/api/version` as `channel`; clients render it, they do not
 * work it out from the version string.
 *
 * The image workflows pass the line as the build arg `NEXT_PUBLIC_APP_CHANNEL`,
 * which the build inlines like the commit SHA beside it: `release` from
 * docker-publish.yml on a `v*` tag (published as `:latest`), `edge` from
 * edge-image.yml on every push to `main` (`:edge`), `nightly` from
 * nightly-image.yml on the newest `release/vX.Y.0` (`:nightly`). A build
 * without a commit SHA is a local or development build whatever the arg says.
 * An image with a SHA and no channel (a release built before 1.50.0, or a
 * self-built image that passes only the SHA) is a release.
 */
export const UPDATE_CHANNELS = [
  "release",
  "edge",
  "nightly",
  "development",
] as const;

export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export function resolveUpdateChannel(
  buildSha: string | null,
  imageChannel: string | null | undefined,
): UpdateChannel {
  if (!buildSha) return "development";
  if (imageChannel === "edge" || imageChannel === "nightly") {
    return imageChannel;
  }
  return "release";
}

/** The image tag a self-hoster pulls for that line, if there is one. */
export const UPDATE_CHANNEL_TAG: Record<UpdateChannel, string | null> = {
  release: ":latest",
  edge: ":edge",
  nightly: ":nightly",
  development: null,
};
