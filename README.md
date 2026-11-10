# Keepatch

A slow, resumable maintenance lane for public GitHub repositories, built from free pieces:
Dependabot proposes updates on its own branches, each repository's CI checks them, and a weekly
Keepatch run ranks what is waiting across your repositories and keeps the state in issues.
People merge.

## Use it

1. Copy [`examples/keepatch.yml`](examples/keepatch.yml) to `.github/workflows/keepatch.yml` and
   replace `COMMIT_SHA` with a full commit SHA of this repository.
2. Copy [`examples/dependabot.yml`](examples/dependabot.yml) to `.github/dependabot.yml` and set
   the ecosystems the repository uses.
3. Run the workflow by hand once with `dry_run` ticked: it prints the report and writes nothing.

```yaml
- uses: helenkwok/keepatch@COMMIT_SHA
  with:
    repos: |
      owner/this-repo
      owner/another-repo
```

| Input | Default | What it does |
|---|---|---|
| `token` | the workflow's token | Reads the repositories, and writes issues in the one running the workflow. Needs `issues: write` and read access to `pull-requests`, `checks` and `statuses`. The default token can read other public repositories; private ones need a token that can. |
| `repos` | the repository running the workflow | Repositories to read into one report. |
| `dry_run` | `false` | Print the report and what would be written, without writing any issue. |

[`.github/workflows/report.yml`](.github/workflows/report.yml) is this repository's own report,
reading several repositories. Running the report from a repository that stays active avoids
GitHub switching scheduled workflows off after 60 days without activity in a quiet one.

## What a run does

For each repository it reads:

- the checks on the default branch;
- every open pull request: checks, reviews and conflicts at its current commit;
- open issues labelled `bug`;
- git dependencies pinned to a revision in `Cargo.toml` files, and how far each pin is behind
  its upstream's default branch.

It ranks them with fixed rules (`rank()` in [`keepatch.mjs`](keepatch.mjs)); every point has a
stated reason. Then it:

1. Rewrites one **report issue** with the ranked queue of all the repositories.
2. Keeps one **task issue**, in the repository running the workflow, for each thing there that
   needs work: checks failing on the default branch, a pull request whose checks fail, or one
   where no check ran on the current commit. Each holds a small checkpoint (commit examined,
   first seen, run count). A fix links to it with `Closes #n`. Keepatch closes the issue when the
   problem is gone.

It finds its own issues by a hidden marker, so a second run updates them and opens no duplicates.
A run that could not read everything closes nothing and says so in the report.

## Rules worth knowing

- **Update pull requests are ranked by semver.** A new major version, or a new minor of a 0.x
  version, is marked "breaking by semver: read the changelog before merging".
- **Pinned git dependencies are reported when they fall behind.** Update bots do not follow a
  dependency fixed to one commit, so nothing else says when such a pin is due.
- **A green check counts as passing only when at least one check ran and succeeded** on the
  current commit. A review counts only when it is of the current commit.
- **The word "security" in a pull request's body is not enough** to rank it as a security update:
  bots quote upstream release notes there. A title, a label or an advisory id is.

## What it will not do

- It never checks out or runs pull request code, never pushes and never merges.
- Titles from pull requests and issues are shown as inline code and never acted on.
- A run makes no request outside the GitHub API.

## Evidence behind the rules

- The semver rule was tested on 9,122 Dependabot pull requests from 2,698 public Rust
  repositories, scored on whether each later failed its checks or needed a fix from a person.
  For Cargo updates the rule alone ranked those well above chance (AUROC 0.69). A small model
  trained on titles did somewhat better (0.75), and may be added once there is history to train
  on. A general-purpose zero-shot classifier did no better than chance (0.52), so none is used.
- The outcome is a proxy: a pull request can fail its checks for reasons unrelated to the update.

## Try it by hand

Node 22 or newer, no dependencies.

```bash
GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=owner/name KEEPATCH_DRY_RUN=1 node keepatch.mjs
```

```bash
node keepatch.mjs --self-test
```

## Not built yet

- Pinned git dependencies outside Cargo manifests.
- A worker that investigates a task issue and proposes a fix on a branch.
- Auto-merge of well-tested patch updates.

## Licence

Keepatch is licensed under either of the [MIT licence](LICENSE-MIT) or the
[Apache License, Version 2.0](LICENSE-APACHE), at your option.
