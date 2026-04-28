import { Repository } from '../../models/repository'
import { ILfsLockInfo, LockState } from '../../models/lfs-lock'
import { isUsingLFS } from '../git/lfs'
import { listLocks, getLockableFiles, getCurrentUser, isOriginReachable } from '../git/lfs-locks'

interface IRepoLockState {
  /** null means the lock list could not be fetched (auth error, no network, etc.) */
  readonly locks: ReadonlyMap<string, ILfsLockInfo> | null
  readonly lockableFiles: ReadonlySet<string>
  readonly currentUser: string | null
}

/** Pure function — exported for testing. */
export function deriveLockState(
  path: string,
  lockableFiles: ReadonlySet<string>,
  locks: ReadonlyMap<string, ILfsLockInfo> | null,
  currentUser: string | null
): LockState {
  if (!lockableFiles.has(path)) {
    return { kind: 'unlocked-not-lockable' }
  }

  if (locks === null) {
    return { kind: 'lock-state-unknown' }
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
  private readonly stateByRepo = new Map<string, IRepoLockState>()
  private readonly refreshByRepo = new Map<string, Promise<void>>()
  // Checked once per session per repo — GitHub's LFS API silently returns []
  // when the token lacks org-level access, so we verify reachability up front
  // rather than on every empty-lock response.
  private readonly remoteReachableByRepo = new Map<string, boolean>()

  /** Refresh lock state. Safe to call on any repo — clears state if repo is not using LFS.
   *  Coalesces concurrent calls for the same repo into one in-flight request. */
  public refresh(
    repository: Repository,
    filePaths: ReadonlyArray<string>
  ): Promise<void> {
    const existing = this.refreshByRepo.get(repository.path)
    if (existing) {
      return existing
    }
    const p = this.doRefresh(repository, filePaths).finally(() => {
      this.refreshByRepo.delete(repository.path)
    })
    this.refreshByRepo.set(repository.path, p)
    return p
  }

  private async doRefresh(
    repository: Repository,
    filePaths: ReadonlyArray<string>
  ): Promise<void> {
    const usingLFS = await isUsingLFS(repository)
    if (!usingLFS) {
      this.stateByRepo.delete(repository.path)
      this.remoteReachableByRepo.delete(repository.path)
      return
    }

    // Check reachability once per session; use cached result on subsequent refreshes.
    if (!this.remoteReachableByRepo.has(repository.path)) {
      const reachable = await isOriginReachable(repository)
      this.remoteReachableByRepo.set(repository.path, reachable)
      if (!reachable) {
        log.warn('lfs-locks-store: origin is not reachable — lock state will be shown as unknown')
      }
    }
    const remoteReachable = this.remoteReachableByRepo.get(repository.path)!

    const [locks, lockableFiles, currentUser] = await Promise.all([
      listLocks(repository),
      getLockableFiles(repository, filePaths),
      getCurrentUser(repository),
    ])

    // GitHub silently returns [] when the token lacks org-level LFS access.
    // If we confirmed at session start that the remote is not reachable, an
    // empty lock list is not authoritative — treat it as unknown.
    const effectiveLocks =
      locks !== null && locks.length === 0 && !remoteReachable ? null : locks

    const lockMap = effectiveLocks === null ? null : new Map<string, ILfsLockInfo>()
    if (effectiveLocks !== null) {
      for (const lock of effectiveLocks) {
        lockMap!.set(lock.path, lock)
      }
    }

    this.stateByRepo.set(repository.path, {
      locks: lockMap,
      lockableFiles,
      currentUser,
    })
  }

  /** Returns LockState for a path, or unlocked-not-lockable if no data for this repo. */
  public getLockStateForPath(repository: Repository, path: string): LockState {
    const state = this.stateByRepo.get(repository.path)
    if (!state) {
      return { kind: 'unlocked-not-lockable' }
    }
    return deriveLockState(path, state.lockableFiles, state.locks, state.currentUser)
  }

  /** Returns a map of path → LockState for all lockable paths. Non-lockable paths are omitted. */
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
      const lockState = deriveLockState(path, state.lockableFiles, state.locks, state.currentUser)
      if (lockState.kind !== 'unlocked-not-lockable') {
        result.set(path, lockState)
      }
    }
    return result
  }
}
