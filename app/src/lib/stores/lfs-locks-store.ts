import { Repository } from '../../models/repository'
import { ILfsLockInfo, LockState } from '../../models/lfs-lock'
import { isUsingLFS } from '../git/lfs'
import { listLocks, getLockableFiles, getCurrentUser } from '../git/lfs-locks'

interface IRepoLockState {
  readonly locks: ReadonlyMap<string, ILfsLockInfo>
  readonly lockableFiles: ReadonlySet<string>
  readonly currentUser: string | null
}

/** Pure function — exported for testing. */
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

  /** Refresh lock state. Safe to call on any repo — clears state if repo is not using LFS. */
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

  /** Returns LockState for a path, or unlocked-not-lockable if no data for this repo. */
  public getLockStateForPath(repository: Repository, path: string): LockState {
    const state = this.stateByRepo.get(repository.path)
    if (!state) {
      return { kind: 'unlocked-not-lockable' }
    }
    return deriveLockState(path, state.lockableFiles, state.locks, state.currentUser)
  }

  /** Returns a map of path → LockState for all given paths. Omits unlocked-not-lockable entries. */
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
