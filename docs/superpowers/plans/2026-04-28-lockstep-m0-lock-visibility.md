# Lockstep M0 — LFS Lock Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface LFS lock state next to files in the changes sidebar — three badge states: locked-by-me, locked-by-other, lockable-but-unlocked. Read-only; no acquire/release actions yet.

**Architecture:** A new `LfsLocksStore` class caches per-repo lock state (from `git lfs locks --json`) and lockable-file sets (from `git check-attr lockable`). `AppStore` calls `refresh()` on existing repo-refresh triggers and adds the result to `IChangesState`. Lock state flows via props from `ChangesSidebar` → `FilterChangesList` → `ChangedFile`, where a new `LockBadge` component renders the icon and tooltip. `WorkingDirectoryFileChange` model is untouched.

**Tech Stack:** TypeScript 5, React 16, Electron 40, `node:test` + `node:assert` for unit tests, `dugite` for git CLI invocations.

---

## File Map

| File | Status | Responsibility |
|------|--------|----------------|
| `app/src/models/lfs-lock.ts` | **Create** | `ILfsLockInfo` and `LockState` discriminated union |
| `app/src/lib/git/lfs-locks.ts` | **Create** | `listLocks`, `getLockableFiles`, `getCurrentUser` git wrappers + `parseLfsLocksJson` |
| `app/src/lib/stores/lfs-locks-store.ts` | **Create** | Per-repo cache + `deriveLockState` pure function |
| `app/src/ui/lfs/lock-badge.tsx` | **Create** | Octicon badge + tooltip |
| `app/styles/ui/changes/_lock-badge.scss` | **Create** | Badge color tokens |
| `app/test/unit/git/lfs-locks-test.ts` | **Create** | Parser unit test + `getLockableFiles` integration test |
| `app/test/unit/lfs-locks-store-test.ts` | **Create** | `deriveLockState` unit tests |
| `app/styles/ui/_changes.scss` | **Modify** | Import `_lock-badge.scss` |
| `app/src/lib/app-state.ts` | **Modify** | Add `lfsLockStates?: ReadonlyMap<string, LockState>` to `IChangesState` |
| `app/src/ui/changes/changed-file.tsx` | **Modify** | Add `lockState?: LockState` prop; render `<LockBadge>` |
| `app/src/ui/changes/filter-changes-list.tsx` | **Modify** | Add `lockStates` prop; look up and pass `lockState` to `ChangedFile` |
| `app/src/ui/changes/sidebar.tsx` | **Modify** | Thread `lfsLockStates` from `changes` props into `FilterChangesList` |
| `app/src/lib/stores/app-store.ts` | **Modify** | Instantiate `LfsLocksStore`, call `refresh()` on repo events, populate `changesState` |

---

## Task 1: Model types

**Files:**
- Create: `app/src/models/lfs-lock.ts`

- [ ] **Step 1: Create the model file**

```typescript
// app/src/models/lfs-lock.ts

export interface ILfsLockInfo {
  readonly id: string
  readonly path: string
  readonly owner: string
  readonly lockedAt: Date
}

export type LockState =
  | { readonly kind: 'unlocked-not-lockable' }
  | { readonly kind: 'unlocked-lockable' }
  | { readonly kind: 'locked-by-me'; readonly info: ILfsLockInfo }
  | { readonly kind: 'locked-by-other'; readonly info: ILfsLockInfo }
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
yarn tsc --noEmit 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add app/src/models/lfs-lock.ts
git commit -m "Add LfsLockInfo and LockState model types"
```

---

## Task 2: Git wrapper — `parseLfsLocksJson` and `listLocks`

**Files:**
- Create: `app/src/lib/git/lfs-locks.ts`
- Create: `app/test/unit/git/lfs-locks-test.ts`

- [ ] **Step 1: Write the failing parser test**

```typescript
// app/test/unit/git/lfs-locks-test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { parseLfsLocksJson } from '../../../src/lib/git/lfs-locks'

describe('parseLfsLocksJson', () => {
  it('parses a single lock entry', () => {
    const json = JSON.stringify([
      {
        id: 42,
        path: 'Assets/Character.uasset',
        locked_at: '2024-01-15T10:30:00.000Z',
        owner: { name: 'james' },
      },
    ])

    const locks = parseLfsLocksJson(json)

    assert.equal(locks.length, 1)
    assert.equal(locks[0].id, '42')
    assert.equal(locks[0].path, 'Assets/Character.uasset')
    assert.equal(locks[0].owner, 'james')
    assert.deepStrictEqual(locks[0].lockedAt, new Date('2024-01-15T10:30:00.000Z'))
  })

  it('returns empty array for empty lock list', () => {
    const locks = parseLfsLocksJson('[]')
    assert.equal(locks.length, 0)
  })

  it('returns empty array for malformed JSON', () => {
    const locks = parseLfsLocksJson('not json')
    assert.equal(locks.length, 0)
  })

  it('skips entries with missing owner', () => {
    const json = JSON.stringify([
      { id: 1, path: 'file.uasset', locked_at: '2024-01-01T00:00:00.000Z' },
    ])
    const locks = parseLfsLocksJson(json)
    assert.equal(locks.length, 0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
yarn test:unit 2>&1 | grep -A3 "parseLfsLocksJson"
```

Expected: error about `parseLfsLocksJson` not found

- [ ] **Step 3: Create `lfs-locks.ts` with parser and `listLocks`**

```typescript
// app/src/lib/git/lfs-locks.ts
import { git } from './core'
import { Repository } from '../../models/repository'
import { ILfsLockInfo } from '../../models/lfs-lock'

interface RawLfsLock {
  id: number | string
  path: string
  locked_at: string
  owner?: { name?: string }
}

/**
 * Parse the JSON output of `git lfs locks --json`.
 * Returns an empty array on malformed input rather than throwing.
 */
export function parseLfsLocksJson(json: string): ReadonlyArray<ILfsLockInfo> {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }

  if (!Array.isArray(raw)) {
    return []
  }

  const results: ILfsLockInfo[] = []
  for (const entry of raw as RawLfsLock[]) {
    const owner = entry.owner?.name
    if (!owner) {
      continue
    }
    results.push({
      id: String(entry.id),
      path: entry.path,
      owner,
      lockedAt: new Date(entry.locked_at),
    })
  }
  return results
}

/**
 * List all LFS locks for the repository.
 * Returns an empty array if the command fails (e.g., no LFS server configured).
 */
export async function listLocks(
  repository: Repository
): Promise<ReadonlyArray<ILfsLockInfo>> {
  try {
    const { stdout } = await git(
      ['lfs', 'locks', '--json'],
      repository.path,
      'listLfsLocks'
    )
    return parseLfsLocksJson(stdout)
  } catch {
    return []
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
yarn test:unit 2>&1 | grep -A5 "parseLfsLocksJson"
```

Expected: all four tests pass

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/git/lfs-locks.ts app/test/unit/git/lfs-locks-test.ts
git commit -m "Add parseLfsLocksJson and listLocks git wrapper"
```

---

## Task 3: Git wrapper — `getLockableFiles` and `getCurrentUser`

**Files:**
- Modify: `app/src/lib/git/lfs-locks.ts` (append)
- Modify: `app/test/unit/git/lfs-locks-test.ts` (append)

- [ ] **Step 1: Write failing integration tests**

Append to `app/test/unit/git/lfs-locks-test.ts`. The `import` statements are already at the top of the file from Task 2 — add only the new imports and `describe` block:

```typescript
import * as Path from 'path'
import { writeFile } from 'fs/promises'
import { setupEmptyRepository } from '../../helpers/repositories'
import { getLockableFiles } from '../../../src/lib/git/lfs-locks'

describe('getLockableFiles', () => {
  it('returns empty set when no files are lockable', async t => {
    const repository = await setupEmptyRepository(t)
    const lockable = await getLockableFiles(repository, ['Assets/file.uasset'])
    assert.equal(lockable.size, 0)
  })

  it('identifies lockable files from .gitattributes', async t => {
    const repository = await setupEmptyRepository(t)
    await writeFile(
      Path.join(repository.path, '.gitattributes'),
      '*.uasset lockable\n'
    )

    const lockable = await getLockableFiles(repository, [
      'Assets/Character.uasset',
      'src/main.ts',
    ])

    assert(lockable.has('Assets/Character.uasset'))
    assert(!lockable.has('src/main.ts'))
  })

  it('returns empty set for empty file list', async t => {
    const repository = await setupEmptyRepository(t)
    const lockable = await getLockableFiles(repository, [])
    assert.equal(lockable.size, 0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
yarn test:unit 2>&1 | grep -A3 "getLockableFiles"
```

Expected: error about `getLockableFiles` not found

- [ ] **Step 3: Add `getLockableFiles` and `getCurrentUser` to `lfs-locks.ts`**

Append to `app/src/lib/git/lfs-locks.ts`:

```typescript
/**
 * Given a list of file paths, returns the subset that are marked `lockable`
 * in .gitattributes. Uses a single `git check-attr` invocation for efficiency.
 */
export async function getLockableFiles(
  repository: Repository,
  filePaths: ReadonlyArray<string>
): Promise<ReadonlySet<string>> {
  if (filePaths.length === 0) {
    return new Set()
  }

  try {
    const { stdout } = await git(
      ['check-attr', 'lockable', '--', ...filePaths],
      repository.path,
      'getLockableFiles'
    )

    // Output format per line: "<path>: lockable: set" or "<path>: lockable: unspecified"
    const lockable = new Set<string>()
    for (const line of stdout.split('\n')) {
      const match = /^(.+): lockable: set$/.exec(line.trim())
      if (match) {
        lockable.add(match[1])
      }
    }
    return lockable
  } catch {
    return new Set()
  }
}

/**
 * Returns the local git user name for ownership comparison.
 * Falls back to null if git config has no user.name set.
 */
export async function getCurrentUser(
  repository: Repository
): Promise<string | null> {
  try {
    const { stdout } = await git(
      ['config', 'user.name'],
      repository.path,
      'getLfsCurrentUser'
    )
    return stdout.trim() || null
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
yarn test:unit 2>&1 | grep -A5 "getLockableFiles"
```

Expected: all three tests pass

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/git/lfs-locks.ts app/test/unit/git/lfs-locks-test.ts
git commit -m "Add getLockableFiles and getCurrentUser git wrappers"
```

---

## Task 4: `LfsLocksStore`

**Files:**
- Create: `app/src/lib/stores/lfs-locks-store.ts`
- Create: `app/test/unit/lfs-locks-store-test.ts`

- [ ] **Step 1: Write failing unit tests for `deriveLockState`**

```typescript
// app/test/unit/lfs-locks-store-test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { deriveLockState } from '../../src/lib/stores/lfs-locks-store'
import { ILfsLockInfo } from '../../src/models/lfs-lock'

const makeInfo = (path: string, owner: string): ILfsLockInfo => ({
  id: '1',
  path,
  owner,
  lockedAt: new Date('2024-01-01T00:00:00.000Z'),
})

describe('deriveLockState', () => {
  it('returns unlocked-not-lockable when path is not lockable', () => {
    const state = deriveLockState(
      'src/main.ts',
      new Set(['*.uasset']),
      new Map(),
      'james'
    )
    assert.equal(state.kind, 'unlocked-not-lockable')
  })

  it('returns unlocked-lockable when lockable but no lock held', () => {
    const state = deriveLockState(
      'Assets/Character.uasset',
      new Set(['Assets/Character.uasset']),
      new Map(),
      'james'
    )
    assert.equal(state.kind, 'unlocked-lockable')
  })

  it('returns locked-by-me when owner matches currentUser', () => {
    const info = makeInfo('Assets/Character.uasset', 'james')
    const state = deriveLockState(
      'Assets/Character.uasset',
      new Set(['Assets/Character.uasset']),
      new Map([['Assets/Character.uasset', info]]),
      'james'
    )
    assert.equal(state.kind, 'locked-by-me')
    if (state.kind === 'locked-by-me') {
      assert.equal(state.info.owner, 'james')
    }
  })

  it('returns locked-by-other when owner does not match currentUser', () => {
    const info = makeInfo('Assets/Character.uasset', 'alice')
    const state = deriveLockState(
      'Assets/Character.uasset',
      new Set(['Assets/Character.uasset']),
      new Map([['Assets/Character.uasset', info]]),
      'james'
    )
    assert.equal(state.kind, 'locked-by-other')
  })

  it('returns locked-by-other when currentUser is null', () => {
    const info = makeInfo('Assets/Character.uasset', 'alice')
    const state = deriveLockState(
      'Assets/Character.uasset',
      new Set(['Assets/Character.uasset']),
      new Map([['Assets/Character.uasset', info]]),
      null
    )
    assert.equal(state.kind, 'locked-by-other')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
yarn test:unit 2>&1 | grep -A3 "deriveLockState"
```

Expected: error about `deriveLockState` not found

- [ ] **Step 3: Create `LfsLocksStore`**

```typescript
// app/src/lib/stores/lfs-locks-store.ts
import { Repository } from '../../models/repository'
import { ILfsLockInfo, LockState } from '../../models/lfs-lock'
import { isUsingLFS } from '../git/lfs'
import { listLocks, getLockableFiles, getCurrentUser } from '../git/lfs-locks'

interface IRepoLockState {
  readonly locks: ReadonlyMap<string, ILfsLockInfo>
  readonly lockableFiles: ReadonlySet<string>
  readonly currentUser: string | null
}

/**
 * Pure function — exported for testing.
 * Derives the LockState for a single file path given the full repo lock state.
 */
export function deriveLockState(
  path: string,
  lockableFiles: ReadonlySet<string>,
  locks: ReadonlyMap<string, ILfsLockInfo>,
  currentUser: string | null
): LockState {
  if (!lockableFiles.has(path)) {
    return { kind: 'unlocked-not-lockable' }
  }

  const lock = locks.get(path)
  if (!lock) {
    return { kind: 'unlocked-lockable' }
  }

  if (currentUser !== null && lock.owner === currentUser) {
    return { kind: 'locked-by-me', info: lock }
  }

  return { kind: 'locked-by-other', info: lock }
}

export class LfsLocksStore {
  private stateByRepo = new Map<string, IRepoLockState>()

  /**
   * Refresh lock state for the repository. Safe to call on any repo —
   * silently clears state if the repo is not using LFS.
   */
  public async refresh(
    repository: Repository,
    filePaths: ReadonlyArray<string>
  ): Promise<void> {
    const usingLFS = await isUsingLFS(repository)
    if (!usingLFS) {
      this.stateByRepo.delete(repository.path)
      return
    }

    const [locks, lockableFiles, currentUser] = await Promise.all([
      listLocks(repository),
      getLockableFiles(repository, filePaths),
      getCurrentUser(repository),
    ])

    const lockMap = new Map<string, ILfsLockInfo>()
    for (const lock of locks) {
      lockMap.set(lock.path, lock)
    }

    this.stateByRepo.set(repository.path, {
      locks: lockMap,
      lockableFiles,
      currentUser,
    })
  }

  /**
   * Returns the LockState for a file path, or unlocked-not-lockable if
   * no lock data is available for this repo.
   */
  public getLockStateForPath(repository: Repository, path: string): LockState {
    const state = this.stateByRepo.get(repository.path)
    if (!state) {
      return { kind: 'unlocked-not-lockable' }
    }
    return deriveLockState(
      path,
      state.lockableFiles,
      state.locks,
      state.currentUser
    )
  }

  /**
   * Returns a map of path → LockState for all given file paths.
   * Skips files where state is unlocked-not-lockable to keep the map small.
   */
  public getLockStatesForPaths(
    repository: Repository,
    paths: ReadonlyArray<string>
  ): ReadonlyMap<string, LockState> {
    const result = new Map<string, LockState>()
    const state = this.stateByRepo.get(repository.path)
    if (!state) {
      return result
    }
    for (const path of paths) {
      const lockState = deriveLockState(
        path,
        state.lockableFiles,
        state.locks,
        state.currentUser
      )
      if (lockState.kind !== 'unlocked-not-lockable') {
        result.set(path, lockState)
      }
    }
    return result
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
yarn test:unit 2>&1 | grep -A8 "deriveLockState"
```

Expected: all five tests pass

- [ ] **Step 5: Compile check**

```bash
yarn tsc --noEmit 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/stores/lfs-locks-store.ts app/test/unit/lfs-locks-store-test.ts
git commit -m "Add LfsLocksStore with deriveLockState pure function"
```

---

## Task 5: `LockBadge` component + styles

**Files:**
- Create: `app/src/ui/lfs/lock-badge.tsx`
- Create: `app/styles/ui/changes/_lock-badge.scss`
- Modify: `app/styles/ui/_changes.scss`

- [ ] **Step 1: Create the badge component**

```tsx
// app/src/ui/lfs/lock-badge.tsx
import * as React from 'react'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { TooltippedContent } from '../lib/tooltipped-content'
import { TooltipDirection } from '../lib/tooltip'
import { LockState } from '../../models/lfs-lock'

interface ILockBadgeProps {
  readonly lockState: LockState
}

/** Badge shown next to a file's status icon when the file is lockable or locked. */
export class LockBadge extends React.Component<ILockBadgeProps, {}> {
  public render() {
    const { lockState } = this.props

    if (lockState.kind === 'unlocked-not-lockable') {
      return null
    }

    if (lockState.kind === 'unlocked-lockable') {
      return (
        <TooltippedContent
          tooltip="Lockable — not currently locked"
          direction={TooltipDirection.EAST}
        >
          <Octicon
            symbol={octicons.unlock}
            className="lock-badge lock-badge--free"
          />
        </TooltippedContent>
      )
    }

    const { info } = lockState
    const when = info.lockedAt.toLocaleDateString()

    if (lockState.kind === 'locked-by-me') {
      return (
        <TooltippedContent
          tooltip={`Locked by you on ${when}`}
          direction={TooltipDirection.EAST}
        >
          <Octicon
            symbol={octicons.lock}
            className="lock-badge lock-badge--mine"
          />
        </TooltippedContent>
      )
    }

    // locked-by-other
    return (
      <TooltippedContent
        tooltip={`Locked by ${info.owner} on ${when}`}
        direction={TooltipDirection.EAST}
      >
        <Octicon
          symbol={octicons.lock}
          className="lock-badge lock-badge--other"
        />
      </TooltippedContent>
    )
  }
}
```

- [ ] **Step 2: Create badge SCSS**

```scss
// app/styles/ui/changes/_lock-badge.scss

.lock-badge {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  margin-left: 4px;

  &.lock-badge--mine {
    color: var(--color-success-fg, #2da44e);
  }

  &.lock-badge--other {
    color: var(--color-danger-fg, #cf222e);
  }

  &.lock-badge--free {
    color: var(--color-fg-muted, #6e7781);
  }
}
```

- [ ] **Step 3: Import SCSS in `_changes.scss`**

Open `app/styles/ui/_changes.scss` and append:

```scss
@import 'changes/lock-badge';
```

The file should now end with:
```scss
@import 'changes/commit-message';
@import 'changes/continue-rebase';
@import 'changes/changes-list';
@import 'changes/undo-commit';
@import 'changes/changes-interstitial';
@import 'changes/oversized-files-warning';
@import 'changes/commit-warning';
@import 'changes/submodule-diff';
@import 'changes/lock-badge';
```

- [ ] **Step 4: Compile check**

```bash
yarn tsc --noEmit 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add app/src/ui/lfs/lock-badge.tsx app/styles/ui/changes/_lock-badge.scss app/styles/ui/_changes.scss
git commit -m "Add LockBadge component and badge styles"
```

---

## Task 6: Add `lockState` prop to `ChangedFile`

**Files:**
- Modify: `app/src/ui/changes/changed-file.tsx`

- [ ] **Step 1: Add `lockState` prop and render badge**

Open `app/src/ui/changes/changed-file.tsx`. Make these changes:

At the top, add import after the existing imports:
```typescript
import { LockBadge } from '../lfs/lock-badge'
import { LockState } from '../../models/lfs-lock'
```

In `IChangedFileProps`, add one optional property after `readonly matches?: IMatches`:
```typescript
readonly lockState?: LockState
```

In the `render()` method, destructure `lockState` alongside the other props:
```typescript
const {
  file,
  availableWidth,
  disableSelection,
  checkboxTooltip,
  focused,
  matches,
  lockState,
} = this.props
```

After the closing `</TooltippedContent>` for the status `Octicon` (currently the last element inside `<div className="file">`), add:
```tsx
{lockState !== undefined && <LockBadge lockState={lockState} />}
```

The final `<div className="file">` should look like:
```tsx
return (
  <div className="file">
    <TooltippedContent
      tooltip={checkboxTooltip}
      direction={TooltipDirection.EAST}
      tagName="div"
    >
      <Checkbox
        tabIndex={-1}
        value={this.checkboxValue}
        onChange={this.handleCheckboxChange}
        disabled={disableSelection}
      />
    </TooltippedContent>

    <PathLabel
      path={path}
      status={status}
      availableWidth={availablePathWidth}
      ariaHidden={true}
      matches={matches}
    />

    <AriaLiveContainer message={pathScreenReaderMessage} />
    <TooltippedContent
      ancestorFocused={focused}
      openOnFocus={true}
      tooltip={fileStatus}
      direction={TooltipDirection.EAST}
    >
      <Octicon
        symbol={iconForStatus(status)}
        className={'status status-' + fileStatus.toLowerCase()}
      />
    </TooltippedContent>
    {lockState !== undefined && <LockBadge lockState={lockState} />}
  </div>
)
```

- [ ] **Step 2: Compile check**

```bash
yarn tsc --noEmit 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add app/src/ui/changes/changed-file.tsx
git commit -m "Add lockState prop and LockBadge rendering to ChangedFile"
```

---

## Task 7: Thread `lockStates` through `FilterChangesList`

**Files:**
- Modify: `app/src/ui/changes/filter-changes-list.tsx`

- [ ] **Step 1: Add `lockStates` to `IFilterChangesListProps`**

Open `app/src/ui/changes/filter-changes-list.tsx`.

Add import near the top with the other model imports:
```typescript
import { LockState } from '../../models/lfs-lock'
```

In `IFilterChangesListProps`, add after `readonly accounts: ReadonlyArray<Account>`:
```typescript
/** LFS lock states keyed by file path. Absent for non-LFS repos. */
readonly lockStates?: ReadonlyMap<string, LockState>
```

- [ ] **Step 2: Pass `lockState` in `renderChangedFile`**

Find `renderChangedFile` at line 420. Inside the method, after destructuring `this.props`, add a lookup:
```typescript
const lockState = this.props.lockStates?.get(file.path)
```

Then pass it to `<ChangedFile>` — add one prop after `matches={matches}`:
```tsx
lockState={lockState}
```

The `<ChangedFile>` element (starting at line 469) should look like:
```tsx
return (
  <ChangedFile
    file={file}
    include={isPartiallyCommittableSubmodule && include ? null : include}
    key={file.id}
    onIncludeChanged={onIncludeChanged}
    availableWidth={availableWidth}
    disableSelection={disableSelection}
    checkboxTooltip={checkboxTooltip}
    focused={this.state.focusedRow === changeListItem.id}
    matches={matches}
    lockState={lockState}
  />
)
```

- [ ] **Step 3: Compile check**

```bash
yarn tsc --noEmit 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add app/src/ui/changes/filter-changes-list.tsx
git commit -m "Thread lockStates prop through FilterChangesList to ChangedFile"
```

---

## Task 8: Thread `lfsLockStates` through `IChangesState` and `ChangesSidebar`

**Files:**
- Modify: `app/src/lib/app-state.ts`
- Modify: `app/src/ui/changes/sidebar.tsx`

- [ ] **Step 1: Add `lfsLockStates` to `IChangesState`**

Open `app/src/lib/app-state.ts`.

Add import near the top:
```typescript
import { LockState } from '../models/lfs-lock'
```

Inside `IChangesState`, add after `readonly workingDirectory: WorkingDirectoryStatus`:
```typescript
/** LFS lock states keyed by file path. Undefined for non-LFS repos. */
readonly lfsLockStates?: ReadonlyMap<string, LockState>
```

- [ ] **Step 2: Thread through `ChangesSidebar`**

Open `app/src/ui/changes/sidebar.tsx`.

In the `render()` method, `lfsLockStates` is already accessible via `this.props.changes.lfsLockStates` since `this.props.changes` is `IChangesState`.

Find the `<FilterChangesList ... />` block (around line 429). Add one prop:
```tsx
lockStates={this.props.changes.lfsLockStates}
```

- [ ] **Step 3: Compile check**

```bash
yarn tsc --noEmit 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/app-state.ts app/src/ui/changes/sidebar.tsx
git commit -m "Add lfsLockStates to IChangesState and thread through ChangesSidebar"
```

---

## Task 9: Wire `LfsLocksStore` into `AppStore`

**Files:**
- Modify: `app/src/lib/stores/app-store.ts`

This is the integration step. No new tests — the integration is covered by manual testing with a real LFS repo.

- [ ] **Step 1: Import and instantiate `LfsLocksStore`**

Open `app/src/lib/stores/app-store.ts`.

Add import near the other store imports:
```typescript
import { LfsLocksStore } from './lfs-locks-store'
```

Inside the `AppStore` class, add a field after the other private fields (search for `private gitStoreCache`):
```typescript
private readonly lfsLocksStore = new LfsLocksStore()
```

- [ ] **Step 2: Create a `refreshLfsLockState` helper method**

Add this private method to `AppStore` (place near the other refresh-related methods, search for `private async _refreshRepository`):

```typescript
private async refreshLfsLockState(repository: Repository): Promise<void> {
  const state = this.repositoryStateCache.get(repository)
  const filePaths = state.changesState.workingDirectory.files.map(f => f.path)

  await this.lfsLocksStore.refresh(repository, filePaths)

  const lfsLockStates = this.lfsLocksStore.getLockStatesForPaths(
    repository,
    filePaths
  )

  this.repositoryStateCache.updateChangesState(repository, () => ({
    lfsLockStates,
  }))
  this.emitUpdate()
}
```

- [ ] **Step 3: Call `refreshLfsLockState` after `_refreshRepository`**

Find `_refreshRepository` method. After its final `this.emitUpdate()` call (or wherever it completes repository refresh), add:

```typescript
// Refresh LFS lock state in parallel with the repository refresh.
// Errors are caught inside the store — this never throws.
this.refreshLfsLockState(repository).catch(err =>
  log.warn('Failed to refresh LFS lock state', err)
)
```

Note: This call is fire-and-forget (`.catch` is attached, not `await`) so it does not slow down the existing refresh path.

- [ ] **Step 4: Also trigger after successful push**

Find the post-push block around line 4856 in `app-store.ts` (the block that starts with `gitStore.clearTagsToPush()`). After `await this._refreshRepository(repository)` (around line 4889), add the same call:

```typescript
this.refreshLfsLockState(repository).catch(err =>
  log.warn('Failed to refresh LFS lock state after push', err)
)
```

- [ ] **Step 5: Compile check**

```bash
yarn tsc --noEmit 2>&1 | head -30
```

Expected: no errors. Fix any type errors before proceeding.

- [ ] **Step 6: Run all tests**

```bash
yarn test:unit 2>&1 | tail -20
```

Expected: all tests pass (the new unit tests from tasks 2–4 plus all existing tests)

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/stores/app-store.ts
git commit -m "Wire LfsLocksStore into AppStore, refresh on repo events and post-push"
```

---

## Manual Verification

After all tasks complete, verify with a real LFS repo that has at least one lock.

- [ ] Build and run the app: `yarn start`
- [ ] Open a repo that uses LFS with the `lockable` attribute set in `.gitattributes`
- [ ] Edit a lockable file (to put it in the changes list)
- [ ] Confirm: no badge appears on non-lockable files
- [ ] Run `git lfs lock <file>` in the terminal to acquire a lock
- [ ] Focus the app — confirm the green "locked by you" badge appears on that file
- [ ] From another git identity (or by editing the lock JSON), confirm the red "locked by other" badge
- [ ] Modify a lockable file without acquiring a lock — confirm the unlock badge ("lockable — not locked") appears

---

## Known Limitations in M0

- **Pattern matching** uses `git check-attr lockable` on the specific file paths currently in the changes view. Files not in the changes view are not checked.
- **Current-user identity** is matched by `git config user.name`. Servers that store a different identity string (e.g., GitHub login vs display name) may misclassify your own locks as "locked by other". Resolved in M2.
- **Nested `.gitattributes` files** in subdirectories are handled by git internally via `check-attr` — no additional work needed.
- **Lock badge width** is not subtracted from `availablePathWidth` in `ChangedFile`. Paths may overlap slightly in narrow windows. Accepted for M0.
