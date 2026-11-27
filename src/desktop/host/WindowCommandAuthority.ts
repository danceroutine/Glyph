/**
 * Tracks the lifetime of commands admitted on one desktop window's attachment. The desktop host checks
 * trust and workspace ownership before handing out its signal. Disconnect, detach, and changes to those
 * permissions revoke all outstanding commands, including requests waiting for a lock or a human.
 * A later attachment receives a fresh signal. An earlier operation keeps the one it was issued.
 */
export class WindowCommandAuthority {
  private lifetime = new AbortController();

  get signal(): AbortSignal {
    return this.lifetime.signal;
  }

  revoke(): void {
    const previous = this.lifetime;
    this.lifetime = new AbortController();
    previous.abort(new Error('The window lost authority over this workspace operation.'));
  }
}
