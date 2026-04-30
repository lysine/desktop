import { chmod, stat } from 'fs/promises'
import * as Path from 'path'
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
    if (entry.id == null) {
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
 * Returns true if `origin` is reachable with current credentials.
 * Used once per session to distinguish "server says no locks" from
 * "server returned [] silently due to insufficient access".
 */
export async function isOriginReachable(repository: Repository): Promise<boolean> {
  try {
    await git(
      ['ls-remote', '--exit-code', '--refs', 'origin', 'HEAD'],
      repository.path,
      'checkLfsRemoteAccess'
    )
    return true
  } catch {
    return false
  }
}

/**
 * List all LFS locks for the repository.
 * Tries the server first; falls back to the local cache if the server call
 * fails (e.g. credential prompt suppressed, no network, or auth error).
 * Returns null when lock state cannot be determined at all — callers should
 * show a "?" badge rather than a misleading "unlocked" state.
 */
export async function listLocks(
  repository: Repository
): Promise<ReadonlyArray<ILfsLockInfo> | null> {
  try {
    const { stdout } = await git(
      ['lfs', 'locks', '--json'],
      repository.path,
      'listLfsLocks'
    )
    return parseLfsLocksJson(stdout)
  } catch (e) {
    log.warn('listLfsLocks: server fetch failed, trying local cache', e instanceof Error ? e : new Error(String(e)))
  }

  try {
    const { stdout } = await git(
      ['lfs', 'locks', '--json', '--local'],
      repository.path,
      'listLfsLocksLocal'
    )
    const local = parseLfsLocksJson(stdout)
    // An empty local cache after a server failure is ambiguous — it could mean
    // "no locks exist" or "we never managed to cache any". Surface as unknown
    // so the UI shows a "?" badge instead of a misleading "unlocked" padlock.
    if (local.length === 0) {
      return null
    }
    return local
  } catch (e) {
    log.warn('listLfsLocks: local cache also failed', e instanceof Error ? e : new Error(String(e)))
    return null
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
  } catch (e) {
    log.warn('getLockableFiles: failed to check lockable attributes', e instanceof Error ? e : new Error(String(e)))
    return new Set()
  }
}

/**
 * Unlock LFS locks by path. Runs all unlocks in parallel, retries each
 * failure once. Returns which paths succeeded and which failed.
 */
export async function unlockLfsFiles(
  repository: Repository,
  locks: ReadonlyArray<ILfsLockInfo>
): Promise<{ succeeded: ReadonlyArray<string>; failed: ReadonlyArray<string> }> {
  const tryUnlock = async (lock: ILfsLockInfo): Promise<boolean> => {
    try {
      await git(
        ['lfs', 'unlock', lock.path],
        repository.path,
        'unlockLfsFile'
      )
      return true
    } catch {
      return false
    }
  }

  const results = await Promise.all(
    locks.map(async lock => {
      const ok = await tryUnlock(lock)
      if (ok) {
        return { path: lock.path, ok: true }
      }
      const retry = await tryUnlock(lock)
      return { path: lock.path, ok: retry }
    })
  )

  const succeeded = results.filter(r => r.ok).map(r => r.path)
  await Promise.all(succeeded.map(p => clearReadOnly(repository, p)))

  return {
    succeeded,
    failed: results.filter(r => !r.ok).map(r => r.path),
  }
}

// `git lfs unlock` doesn't always flip the read-only bit on the working-tree
// file. Unreal's Source Control plugin (and other Perforce-style tools) keys
// off that bit to know whether a file is checked out, so leaving it set means
// the editor still sees the file as locked until the user manually refreshes.
async function clearReadOnly(
  repository: Repository,
  relativePath: string
): Promise<void> {
  const fullPath = Path.join(repository.path, relativePath)
  try {
    const s = await stat(fullPath)
    await chmod(fullPath, s.mode | 0o200)
  } catch (e) {
    log.warn(
      `clearReadOnly: failed for ${relativePath}`,
      e instanceof Error ? e : new Error(String(e))
    )
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
  } catch (e) {
    log.warn('getCurrentUser: failed to read git user.name', e instanceof Error ? e : new Error(String(e)))
    return null
  }
}
