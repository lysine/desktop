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
