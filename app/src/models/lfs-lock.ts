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
  | { readonly kind: 'lock-state-unknown' }
