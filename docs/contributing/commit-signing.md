# Commit signing

Maintainer commits on `main` are signed. Contributors are welcome to sign and are not required to; why is at the end of this page.

## Set up signing with an SSH key

Git can sign with the same kind of key you already push with. A key used only for signing keeps the two roles apart:

```bash
ssh-keygen -t ed25519 -C "git signing" -f ~/.ssh/git_signing_ed25519
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/git_signing_ed25519.pub
git config --global commit.gpgsign true
```

Add the public key on GitHub under **Settings → SSH and GPG keys → New SSH key** with the key type **Signing Key**. GitHub then shows your commits as Verified when the committer email is a verified address of your account.

Release tags are annotated and signed with the same key (`git tag -s`, see `docs/contributing/release-policy.md`); `tag.gpgsign` is not needed for that.

## Verify locally

`git log --show-signature` and `%G?` need to know which key belongs to whom. That is the allowed-signers file: one line per key, `<email> namespaces="git" <key type> <key>`. Build it from the signing keys a GitHub account publishes:

```bash
user=<github-login> email=<committer-email>
gh api "users/$user/ssh_signing_keys" --jq '.[].key' |
  sed "s|^|$email namespaces=\"git\" |" >> ~/.config/git/allowed_signers
git config --global gpg.ssh.allowedSignersFile ~/.config/git/allowed_signers
```

The repository does not ship this file: it would put personal email addresses into the history, and it would be a second, unreviewed list of who may sign.

```bash
git log --format='%G? %h %an %s' origin/main -20
```

reads `G` for a good signature, `N` for none and `E` for one git cannot check here, usually because the key is not in the allowed-signers file or the keyring. Merge commits created on github.com, Dependabot's commits and the squash commits GitHub writes are signed with GitHub's own OpenPGP key, so they read `E` until that key is in your GnuPG keyring:

```bash
curl -fsSL https://github.com/web-flow.gpg | gpg --import
```

## Where unsigned commits come from

`commit.gpgsign` covers `commit`, `merge`, `rebase`, `cherry-pick`, `am` and `revert`. Three things produce unsigned commits anyway:

- **Plumbing.** `git commit-tree` ignores `commit.gpgsign`; pass `-S`. A script or tool that rewrites history through it (a message fix, a rebuilt merge) writes unsigned commits in the middle of signed ones.
- **Turning the setting off.** `git -c commit.gpgsign=false …` and `--no-gpg-sign`. Do not use either in this repository.
- **Fast-forwarded rebases.** `git rebase` keeps a commit whose parent did not change as it is, signature or not. `git rebase --force-rebase <base>` re-creates every commit and signs it.

The `pre-push` hook (`scripts/check-signed-push.sh`, wired through `lefthook.yml`) refuses to push a commit whose committer is your `user.email` and that carries no signature, but only when `commit.gpgsign` is on in your clone. It checks that a signature is present, not that it verifies, so it needs no allowed-signers file.

Check a branch before you open a pull request:

```bash
git log --format='%G? %h %s' origin/main..HEAD
```

## Why contributors are not required to sign

Most outside contributions arrive as unsigned commits from forks and are merged with a merge commit, which keeps each contributor's commits and authorship. GitHub's "Require signed commits" rule applies to every commit a merge brings onto the branch, so turning it on would block every such pull request until its author set up signing. The rule stays off for that reason; the maintainer's own commits are signed, and the merge commits GitHub creates are signed by GitHub.
