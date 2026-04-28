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
