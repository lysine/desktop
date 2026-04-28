import * as React from 'react'
import { Repository } from '../../models/repository'
import { ILfsLockInfo } from '../../models/lfs-lock'
import { unlockLfsFiles } from '../../lib/git/lfs-locks'
import { Dialog, DialogContent, DialogFooter } from '../dialog'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { PathText } from '../lib/path-text'
interface ILfsLockReleaseDialogProps {
  readonly repository: Repository
  readonly locks: ReadonlyArray<ILfsLockInfo>
  readonly onDismissed: () => void
}

interface ILfsLockReleaseDialogState {
  readonly isReleasing: boolean
  readonly failedPaths: ReadonlyArray<string>
  readonly done: boolean
}

export class LfsLockReleaseDialog extends React.Component<
  ILfsLockReleaseDialogProps,
  ILfsLockReleaseDialogState
> {
  public constructor(props: ILfsLockReleaseDialogProps) {
    super(props)
    this.state = { isReleasing: false, failedPaths: [], done: false }
  }

  public render() {
    const { locks } = this.props
    const { isReleasing, failedPaths, done } = this.state

    if (done && failedPaths.length > 0) {
      const succeeded = locks.length - failedPaths.length
      return (
        <Dialog
          id="lfs-lock-release"
          title="Release LFS Locks"
          onSubmit={this.props.onDismissed}
          onDismissed={this.props.onDismissed}
        >
          <DialogContent>
            <p>
              {succeeded} of {locks.length} lock
              {locks.length !== 1 ? 's' : ''} released.
            </p>
            <p>Failed to release:</p>
            <ul>
              {failedPaths.map(p => (
                <li key={p}>
                  <PathText path={p} />
                </li>
              ))}
            </ul>
          </DialogContent>
          <DialogFooter>
            <OkCancelButtonGroup
              okButtonText="Close"
              cancelButtonVisible={false}
              onOkButtonClick={this.props.onDismissed}
            />
          </DialogFooter>
        </Dialog>
      )
    }

    return (
      <Dialog
        id="lfs-lock-release"
        title="Release LFS Locks"
        backdropDismissable={false}
        onSubmit={this.onRelease}
        onDismissed={this.props.onDismissed}
        loading={isReleasing}
        disabled={isReleasing}
      >
        <DialogContent>
          <p>You pushed files that you have locked. Release your locks now?</p>
          <ul>
            {locks.map(l => (
              <li key={l.id}>
                <PathText path={l.path} />
              </li>
            ))}
          </ul>
        </DialogContent>
        <DialogFooter>
          <OkCancelButtonGroup
            okButtonText="Release Locks"
            cancelButtonText="Skip"
            onCancelButtonClick={this.props.onDismissed}
          />
        </DialogFooter>
      </Dialog>
    )
  }

  private onRelease = async () => {
    this.setState({ isReleasing: true })
    const { succeeded, failed } = await unlockLfsFiles(
      this.props.repository,
      this.props.locks
    )
    log.info(
      `LFS lock release: ${succeeded.length} succeeded, ${failed.length} failed`
    )
    if (failed.length === 0) {
      this.props.onDismissed()
    } else {
      this.setState({ isReleasing: false, failedPaths: failed, done: true })
    }
  }
}
