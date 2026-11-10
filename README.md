# Keepatch

A slow, resumable maintenance lane for a public GitHub repository, built from free pieces:
Dependabot proposes updates on its own branches, the repository's CI checks them, and a weekly
Keepatch run ranks what is waiting and keeps the state in issues. People merge.

## Use it

1. Copy [`examples/keepatch.yml`](examples/keepatch.yml) to `.github/workflows/keepatch.yml` and
   replace `COMMIT_SHA` with a full commit SHA of this repository.
2. Copy [`examples/dependabot.yml`](examples/dependabot.yml) to `.github/dependabot.yml` and set
   the ecosystems the repository uses.
3. Run the workflow by hand once with `dry_run` ticked: it prints the report and writes nothing.

```yaml
- uses: helenkwok/keepatch@COMMIT_SHA
  with:
    dry_run: "false"
```

| Input | Default | What it does |
|---|---|---|
| `token` | the workflow's token | Reads pull requests and checks, writes issues. Needs `issues: write` and read access to `pull-requests`, `checks` and `statuses`. |
| `dry_run` | `false` | Print the report and what would be written, without writing any issue. |
| `tinydecide` | `true` | Add TinyDecide scores as a column. Shown, never used for ranking. |

## What a run does

1. Reads the default branch's checks, every open pull request (checks, reviews and conflicts at
   its current commit) and open `bug` issues.
2. Ranks them with fixed rules (`rank()` in [`keepatch.mjs`](keepatch.mjs)); every point has a
   stated reason.
3. Rewrites one **report issue** with the ranked queue.
4. Keeps one **task issue** for each thing that needs work: checks failing on the default branch,
   a pull request whose checks fail, or one where no check ran on the current commit. Each holds a
   small checkpoint (commit examined, first seen, run count). A fix links to it with `Closes #n`.
   Keepatch closes the issue when the problem is gone.

It finds its own issues by a hidden marker, so a second run updates them and opens no duplicates.
A run that could not read everything closes nothing and says so in the report.

## What it will not do

- It never checks out or runs pull request code, never pushes and never merges.
- Titles from pull requests and issues are shown as inline code and never acted on.
- A green check counts as passing only when at least one check ran and succeeded on the current
  commit. A review counts only when it is of the current commit.
- A run makes no request outside the GitHub API: the model it uses ships in this repository.

## TinyDecide

[TinyDecide](https://huggingface.co/TheREZOR/TinyDecide) (6 MB, Apache-2.0, by REZOR) is vendored
in [`vendor/tinydecide`](vendor/tinydecide) at a pinned commit. Each run adds its scores as a
column of the report. The scores are shown, never used for ranking: on 25 labelled issues of one
repository it told bug from enhancement 18 times (AUROC about 0.73), which is not enough to
reorder a queue. The column is there to collect evidence.

## Try it by hand

Node 22 or newer, no dependencies.

```bash
GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=owner/name KEEPATCH_DRY_RUN=1 node keepatch.mjs
```

```bash
node keepatch.mjs --self-test
```

## Not built yet

- A worker that investigates a task issue and proposes a fix on a branch.
- Auto-merge of well-tested patch updates.

## Licence

Keepatch is licensed under either of the [MIT licence](LICENSE-MIT) or the
[Apache License, Version 2.0](LICENSE-APACHE), at your option. The vendored TinyDecide files keep
their own licence (`vendor/tinydecide/LICENSE`).
