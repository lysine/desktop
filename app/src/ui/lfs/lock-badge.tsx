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
