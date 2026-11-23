/**
 * Which image line a build came from, read off `/api/version`.
 *
 * A release image carries its tag as the version (`v1.49.0`) and is published
 * as `:latest`; an edge image, built from every push to `main`, carries the
 * release it builds on plus `-edge.<sha>` (`edge-image.yml`) and is published
 * as `:edge`; a build without a SHA is a local or development build.
 */
export type UpdateChannel = "release" | "edge" | "development";

export function updateChannelOf(
  version: string,
  buildSha: string | null,
): UpdateChannel {
  if (!buildSha) return "development";
  return /-edge\./.test(version) ? "edge" : "release";
}

/** The image tag a self-hoster pulls for that line, if there is one. */
export const UPDATE_CHANNEL_TAG: Record<UpdateChannel, string | null> = {
  release: ":latest",
  edge: ":edge",
  development: null,
};
