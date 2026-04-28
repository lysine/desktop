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

  it('returns unlocked-lockable when currentUser is null and no lock held', () => {
    const state = deriveLockState(
      'Assets/Character.uasset',
      new Set(['Assets/Character.uasset']),
      new Map(),
      null
    )
    assert.equal(state.kind, 'unlocked-lockable')
  })

  it('returns lock-state-unknown when locks is null (fetch failed)', () => {
    const state = deriveLockState(
      'Assets/Character.uasset',
      new Set(['Assets/Character.uasset']),
      null,
      'james'
    )
    assert.equal(state.kind, 'lock-state-unknown')
  })

  it('returns unlocked-not-lockable even when locks is null if path is not lockable', () => {
    const state = deriveLockState(
      'src/main.ts',
      new Set(['Assets/Character.uasset']),
      null,
      'james'
    )
    assert.equal(state.kind, 'unlocked-not-lockable')
  })
})
