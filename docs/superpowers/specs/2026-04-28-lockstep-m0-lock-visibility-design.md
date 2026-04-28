# Lockstep M0 — LFS Lock Visibility (Read-Only)

**Status:** Approved 2026-04-28
**Scope:** First milestone of Lockstep, a fork of GitHub Desktop targeting game-dev workflows.

## Context

Game studios use git+LFS for binary assets (uassets, textures, 3D models). Files marked `lockable` in `.gitattributes` require an LFS lock before editing to prevent parallel modifications. Today, no desktop git client surfaces lock state directly in the changes UI — users must drop to a terminal and run `git lfs locks` to see who holds what.

M0 is the foundation: render lock state next to files in the changes sidebar, so the user can see at a glance whether a file they've modified is locked by them, locked by someone else, or lockable but unlocked (a workflow violation). M0 is read-only — no acquire/release actions, no push hook. Those land in M1 and M2 respectively.

## Goals

- The user opens a repo with LFS locks; locked files in the changes sidebar show a badge identifying the lock state.
- Three lock states are surfaced: **locked by me**, **locked by someone else**, **lockable but unlocked**. A file that isn't lockable shows no badge.
- Lock state refreshes on the same triggers the existing repo state already refreshes on (open repo, post-commit, post-pull, post-push, and the existing toolbar fetch/refresh button). M0 adds no new manual-refresh UI affordance.
- Repos without LFS configured behave exactly as today; no new errors, no UI clutter.

## Non-goals (deferred to later milestones)

- Acquiring or releasing locks via the UI (M1)
- Auto-release of locks after successful push (M2)
- Post-push "release these locks?" modal (M3)
- Lock state in views other than the changes sidebar (history, diff)
- Polling / live updates between refresh triggers
- Branding rename to "Lockstep" (M4)
- Genericizing GitHub-specific UI for non-GitHub remotes (later)

## Architecture

A new `LfsLocksStore` holds per-repo lock state and `lockable` patterns parsed from working-tree `.gitattributes`. The existing `WorkingDirectoryFileChange` model is **untouched** — lock state is looked up by file path at render time. A new `LockBadge` component renders next to the existing status icon when the file is lockable or locked.

This deliberately keeps the change isolated to a parallel store rather than threading lock state through the file model. The model is value-typed and passed by copy through 20+ files in the existing codebase; mutating it would create perpetual merge conflicts with upstream `desktop/desktop`. The parallel store touches one new file plus the row component for integration.

The store refreshes on the same triggers the existing repo state already refreshes on. No polling.

## Components

### New files

| File | Responsibility |
|------|----------------|
| `app/src/lib/git/lfs-locks.ts` | Wrapper over `git lfs locks --json`. Exports `listLocks(repo): Promise<LockInfo[]>`. |
| `app/src/lib/git/gitattributes.ts` | Reads working-tree `.gitattributes`. Exports `getLockablePatterns(repo): Promise<string[]>`. |
| `app/src/lib/stores/lfs-locks-store.ts` | Owns per-repo lock state. Extends `BaseStore`. Exposes `refresh(repo)` and `getLockStateForPath(repo, path): LockState`. Emits change events. |
| `app/src/models/lfs-lock.ts` | `LockInfo { id, path, owner, lockedAt }` and `LockState` discriminated union. |
| `app/src/ui/lfs/lock-badge.tsx` | Octicon-based badge component with tooltip showing owner + locked-at. |

### Modified files

| File | Change |
|------|--------|
| `app/src/ui/changes/changed-file.tsx` | Render `<LockBadge state={...} />` after the status icon. Receives `LockState` via props. |
| `app/src/lib/stores/app-store.ts` | Call `LfsLocksStore.refresh()` from the existing refresh paths. Gate on `isUsingLFS()`. Pass `LockState` for each file down to row props. |

### Data model

```ts
type LockState =
  | { kind: 'unlocked-not-lockable' }
  | { kind: 'unlocked-lockable' }
  | { kind: 'locked-by-me'; owner: string; lockedAt: Date; lockId: string }
  | { kind: 'locked-by-other'; owner: string; lockedAt: Date; lockId: string }

interface LockInfo {
  id: string
  path: string
  owner: string
  lockedAt: Date
}
```

## Data flow

1. User opens a repo, or commits, or pulls, or pushes, or clicks manual refresh.
2. `AppStore` invokes `LfsLocksStore.refresh(repo)`.
3. Store calls `isUsingLFS(repo)`. If false, clears any existing entries for this repo and returns silently.
4. Otherwise calls `listLocks(repo)` and `getLockablePatterns(repo)` in parallel, updates its internal maps, emits change.
5. `AppStore` listens for the change event, calls `LfsLocksStore.getLockStateForPath(repo, path)` for each file in the working directory, and includes the result in the props passed down through `ChangesSidebar` → `FilterChangesList` → `ChangedFile`. (Prop-drilling matches the existing pattern in this codebase; no React context.)
6. `ChangedFile` passes `LockState` to `<LockBadge />`.
7. `LockBadge` renders nothing for `unlocked-not-lockable`; otherwise renders the appropriate icon with a tooltip.

`LockState` derivation (in the store):
- If no lockable pattern matches the file path → `unlocked-not-lockable`
- If a lock entry exists for the path:
  - Owner string matches current user (see "Current-user identity" below) → `locked-by-me`
  - Otherwise → `locked-by-other`
- Otherwise (lockable but no lock) → `unlocked-lockable`

## Error handling

| Condition | Behavior |
|-----------|----------|
| Repo has no LFS configured (`isUsingLFS` returns false) | Silent. No badges. No calls. |
| `git lfs locks --json` errors or returns non-JSON | Log warning. Retain previous state. Toast on user-initiated manual refresh only; silent on automatic refreshes. |
| `git lfs locks --json` not supported (very old git-lfs) | Detected via error parsing. Log warning. Disable lock badges for this repo for the session. |
| `.gitattributes` missing or unparseable | Treat as "no lockable patterns". Not an error. |
| Current-user identity unresolvable | Default lock-owner comparison to "not me" (conservative — avoids falsely labeling someone else's lock as "yours"). |
| LFS server unreachable / auth failure | Same as "errors": retain previous state, log, toast only on user-initiated refresh. |

## Decisions

**Pattern matching for `lockable`.** Use a small in-tree gitignore-style glob matcher rather than pull in a new dependency. The existing codebase uses git's own pattern matching via `git check-attr` for filter detection (see `app/src/lib/git/lfs.ts`); for the lockable flag we need to match patterns ourselves because we want the result keyed by working-directory path without invoking git per file.

**Current-user identity.** For M0, match the lock owner string against `git config user.name` and `user.email`. LFS servers vary in what they put in the owner field (GitHub returns the GitHub username; Gitea returns the Gitea username; raw LFS servers may return whatever the lock-acquire credentials supplied). M0 accepts that some server/identity combinations may always classify the user's own locks as `locked-by-other`. Server-specific identity resolution is M2 work, since the auto-release flow needs it to be reliable.

## Testing

| Test | Scope |
|------|-------|
| Unit | JSON parser in `lfs-locks.ts` against captured `git lfs locks --json` samples |
| Unit | `.gitattributes` parser: various pattern shapes, comments, multi-attribute lines |
| Unit | `LockState` derivation — table-driven, all four kinds with various inputs |
| Unit | `LfsLocksStore` state transitions: refresh succeeds, refresh fails, repo without LFS, repeated refresh |
| Manual | Real LFS repo with at least one lock held by the current user and one held by another user; verify three badge states render correctly |

No Playwright/E2E tests for M0 — the visual surface is small enough that manual confirmation is sufficient. Add Playwright coverage in M1 once the manual lock/unlock actions exist.

## Risks / unknowns to watch during implementation

- **JSON output stability of `git lfs locks --json`.** Should capture real samples from at least two LFS servers (GitHub + one other) to confirm the parser handles both. If servers diverge meaningfully, fall back to text-format parsing.
- **`.gitattributes` parsing edge cases.** Specifically: macros (`[attr]binary -text -diff`), nested attribute files in subdirectories. M0 will read only the top-level `.gitattributes`; nested files are documented as a known limitation if encountered.
- **Refresh latency.** `git lfs locks` over a slow network could block the existing refresh-after-commit/pull/push UI updates. The fetch should not block the existing refresh — it runs in parallel and updates the badge when it returns.
