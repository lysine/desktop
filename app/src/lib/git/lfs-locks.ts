import { git } from './core'
import { Repository } from '../../models/repository'
import { ILfsLockInfo } from '../../models/lfs-lock'

interface RawLfsLock {
  id?: number | string
  path?: string
  locked_at?: string
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
    if (typeof entry.path !== 'string' || !entry.path || typeof entry.locked_at !== 'string') {
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
  } catch (e) {
    log.warn('listLfsLocks: failed to list LFS locks', e instanceof Error ? e : new Error(String(e)))
    return []
  }
}

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
