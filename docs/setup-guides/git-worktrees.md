# Working with git worktrees

A git worktree lets one repo have multiple working directories checked out to
different branches simultaneously — separate folders to edit in parallel
without `git stash` ping-pong. Each worktree has its own working tree and
HEAD; they share the same `.git` object store, so commits are visible across
all of them immediately.

This guide walks through using worktrees to implement two refactoring
suggestions in parallel (e.g. depth-audit #5 and #6).

## Concrete walkthrough

From the repo at `C:\Users\alexa\Desktop\histforge`:

```powershell
# 1. Start from a clean, current master
git status
git checkout master
git pull

# 2. Create one worktree per task, each on a new branch
git worktree add ../histforge-05-image-seam -b depth-05-image-moderator-seam master
git worktree add ../histforge-06-step-harness -b depth-06-step-harness master
```

You now have three folders:

- `C:\Users\alexa\Desktop\histforge\` — original, on whatever branch
- `C:\Users\alexa\Desktop\histforge-05-image-seam\` — fresh checkout on `depth-05-image-moderator-seam`
- `C:\Users\alexa\Desktop\histforge-06-step-harness\` — fresh checkout on `depth-06-step-harness`

Each folder has its own `node_modules`. Run `npm install` in each — Windows
plus native modules like `better-sqlite3` makes symlink tricks fragile, so
just install per-worktree.

## Working in them

Open one Claude Code session (or terminal) per folder. Each behaves like an
independent repo. Commit normally:

```powershell
# In histforge-05-image-seam
git add src/lib/image/...
git commit -m "..."

# In histforge-06-step-harness — totally independent
git add src/worker/pipeline.ts
git commit -m "..."
```

`data/histforge.db` is **not** shared — each worktree has its own copy from
whatever was committed at branch-point. Don't run the dev server in two
worktrees against the same DB; two workers will fight over the queue.

## Listing, switching, finishing

```powershell
git worktree list                            # see all worktrees
```

When a branch is merged and you're done:

```powershell
git worktree remove ../histforge-05-image-seam
git branch -d depth/05-image-moderator-seam  # if already merged
```

`worktree remove` refuses if the folder has uncommitted changes — that's the
safety net. Don't just `rm -rf` the folder; that leaves stale metadata. If
you ever do, `git worktree prune` cleans it up.

## Windows gotchas

- **Path length:** worktrees nested deep in long paths can hit Windows' 260-char limit during `npm install`. Keep them at `C:\Users\alexa\Desktop\` level, not inside the repo.
- **Don't nest worktrees inside the main repo** (`./worktrees/foo`) — confuses tooling. Put them as siblings.
- **`better-sqlite3` rebuild:** each worktree's `node_modules` is independent; `npm install` rebuilds the native module each time. Annoying but not broken.
- **The main repo's branch is "claimed"** by the main checkout — you can't `git worktree add` a second copy of the same branch. That's why step 2 creates new branches.

## Suggested workflow

1. Spin up both worktrees from `master` as above.
2. Two Claude Code sessions, each `cd`'d into its worktree, each working on its suggestion.
3. When one finishes, open a PR (or merge to master locally), then `git worktree remove` it.
4. The other worktree keeps going — `git pull --rebase origin master` inside it picks up the first one's changes, then merge.

The rebase-before-merge step is where unexpected overlap surfaces. For
disjoint refactors (like depth-audit #5 and #6) there should be none.

## Reference: parallelization plan for the depth audit

See `docs/refactoring/depth-audit-2026-05-12.md` for the suggestions. The
plan worked out for parallel execution:

- **Wave 1** (four worktrees in parallel): #5, #6, #7, #8
- **Wave 2** (two worktrees in parallel, after Wave 1): #3, #4

Wave 2 is sequenced after Wave 1 because #3 collides with #5 on
`moderator.ts`, #3 collides with #8 on every `steps/*` file, and #4
collides head-on with both #6 (pipeline body) and #7 (submit-result route).
