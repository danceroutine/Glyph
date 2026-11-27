/**
 * Tracks the lifetime of commands admitted on one desktop window's attachment. The desktop host checks
 * trust and workspace ownership before handing out its signal. Disconnect, detach, and changes to those
 * permissions revoke all outstanding commands, including requests waiting for a lock or a human.
 * A later attachment receives a fresh signal. An earlier operation keeps the one it was issued.
 */
export class WindowCommandAuthority {
  private lifetime = new AbortController();
  private port = new AbortController();

  /** An attach or detach belongs to the transport which submitted it, including while the request is queued. */
  get transport(): AbortSignal {
    return this.port.signal;
  }

  /** A replacement renderer must negotiate its own attachment even when it resumes the same window session. */
  disconnect(): void {
    const departed = this.port;
    this.port = new AbortController();
    this.revoke();
    departed.abort(new Error('The workspace connection has ended. Reconnect before attaching.'));
  }

  /** Capture this signal when dispatching a command. Carry that same signal through any queues or approval prompts. */
  get signal(): AbortSignal {
    return this.lifetime.signal;
  }

  /** End the current workspace grant while keeping the port available for the next attachment handshake. */
  revoke(): void {
    const previous = this.lifetime;
    this.lifetime = new AbortController();
    previous.abort(new Error('The window lost authority over this workspace operation.'));
  }
}
