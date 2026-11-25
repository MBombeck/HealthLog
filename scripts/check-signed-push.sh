#!/bin/sh
# pre-push: refuse to push an unsigned commit you created yourself while your
# git config says you sign.
#
# `commit.gpgsign` is honoured by commit, merge, rebase, cherry-pick and am,
# but not by the plumbing: `git commit-tree` writes an unsigned commit unless
# it is given `-S`, whatever the config says. History surgery built on it
# (or on a tool that calls it) leaves unsigned commits between signed ones,
# and nothing notices until they are on `main`.
#
# Only commits whose committer is this clone's `user.email` are checked, and
# only when `commit.gpgsign` is true here: a contributor who does not sign is
# not blocked, and a contributor's commit merged locally keeps its own
# committer. The check looks for a signature header in the commit object; it
# does not verify the signature, so it works without an allowed-signers file.
#
# Reads git's pre-push lines on stdin: <local ref> <local sha> <remote ref> <remote sha>.
set -eu

[ "$(git config --bool commit.gpgsign 2>/dev/null || echo false)" = "true" ] || exit 0
me="$(git config user.email 2>/dev/null || true)"
[ -n "$me" ] || exit 0

zero=0000000000000000000000000000000000000000
unsigned=""
while read -r _local_ref local_sha _remote_ref remote_sha; do
  case "$local_sha" in "$zero"|"") continue ;; esac
  if [ "$remote_sha" = "$zero" ]; then
    range="$local_sha --not --remotes"
  else
    range="$remote_sha..$local_sha"
  fi
  # shellcheck disable=SC2086 # the range is two words on purpose
  for sha in $(git rev-list $range); do
    [ "$(git log -1 --format=%ce "$sha")" = "$me" ] || continue
    if ! git cat-file commit "$sha" | sed '/^$/q' | grep -q '^gpgsig'; then
      unsigned="$unsigned $sha"
    fi
  done
done

[ -z "$unsigned" ] && exit 0

echo "ERROR: these commits are yours and unsigned, although commit.gpgsign is on:" >&2
for sha in $unsigned; do
  echo "  $(git log -1 --format='%h %s' "$sha")" >&2
done
echo "Re-create them signed, for example: git rebase --force-rebase <base>" >&2
echo "(add --rebase-merges when the range holds merges). A commit made with" >&2
echo "git commit-tree needs -S. See docs/contributing/commit-signing.md." >&2
exit 1
