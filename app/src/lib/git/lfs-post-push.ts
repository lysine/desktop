import { git } from './core'
import { Repository } from '../../models/repository'
import { ILfsLockInfo } from '../../models/lfs-lock'
import { listLocks, getCurrentUser } from './lfs-locks'

/**
 * Returns the SHA of the tip of `origin/<branch>` before the push, so we can
 * diff against it after the push to find which files were included.
 * Returns null if no upstream exists (first push to a new branch).
 */
export async function getRemoteTipBeforePush(
  repository: Repository,
  remoteName: string,
  branchName: string
): Promise<string | null> {
  try {
    const { stdout } = await git(
      ['rev-parse', `${remoteName}/${branchName}`],
      repository.path,
      'getRemoteTipBeforePush'
    )
    return stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * Returns the locks that should be offered for release after a successful push.
 *
 * A lock is releasable when ALL of:
 *  - the file was included in the commits just pushed (between remoteTipBefore and HEAD)
 *  - the current user owns the lock
 *  - the file is clean in the working directory (no further uncommitted changes)
 */
export async function getReleasableLocks(
  repository: Repository,
  remoteTipBefore: string
): Promise<ReadonlyArray<ILfsLockInfo>> {
  const [pushedFilesResult, locks, currentUser] = await Promise.all([
    getPushedFiles(repository, remoteTipBefore),
    listLocks(repository),
    getCurrentUser(repository),
  ])

  if (!locks || !currentUser || pushedFilesResult.size === 0) {
    return []
  }

  const myLocks = locks.filter(
    l => l.owner === currentUser && pushedFilesResult.has(l.path)
  )

  if (myLocks.length === 0) {
    return []
  }

  const cleanFiles = await getCleanFiles(repository, myLocks.map(l => l.path))
  return myLocks.filter(l => cleanFiles.has(l.path))
}

async function getPushedFiles(
  repository: Repository,
  remoteTipBefore: string
): Promise<ReadonlySet<string>> {
  try {
    const { stdout } = await git(
      ['diff', '--name-only', `${remoteTipBefore}..HEAD`],
      repository.path,
      'getPushedFiles'
    )
    const files = stdout
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
    return new Set(files)
  } catch {
    return new Set()
  }
}

async function getCleanFiles(
  repository: Repository,
  paths: ReadonlyArray<string>
): Promise<ReadonlySet<string>> {
  try {
    const { stdout } = await git(
      ['status', '--porcelain', '--', ...paths],
      repository.path,
      'getLfsCleanFiles'
    )
    const dirtyFiles = new Set(
      stdout
        .split('\n')
        .map(l => l.slice(3).trim())
        .filter(Boolean)
    )
    return new Set(paths.filter(p => !dirtyFiles.has(p)))
  } catch {
    return new Set()
  }
}
