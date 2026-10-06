import { ShutdownSignal } from './ShutdownSignal.ts';

interface SignalSource {
  on(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
}

interface InterruptSource {
  on(signal: ShutdownSignal.SIGINT, listener: () => void): unknown;
  off(signal: ShutdownSignal.SIGINT, listener: () => void): unknown;
}

export function installShutdownHandlers(
  options: {
    active: () => AbortController | undefined;
    shutdown: (signal: ShutdownSignal) => void;
    interrupt?: InterruptSource;
  },
  source: SignalSource = process,
): () => void {
  const handle = (signal: ShutdownSignal): void => {
    const active = options.active();
    if (signal === ShutdownSignal.SIGINT && active && !active.signal.aborted) {
      active.abort();
      return;
    }
    active?.abort();
    options.shutdown(signal);
  };
  const onInterrupt = (): void => handle(ShutdownSignal.SIGINT);
  const onTerminate = (): void => handle(ShutdownSignal.SIGTERM);
  source.on(ShutdownSignal.SIGINT, onInterrupt);
  source.on(ShutdownSignal.SIGTERM, onTerminate);
  options.interrupt?.on(ShutdownSignal.SIGINT, onInterrupt);
  return () => {
    source.off(ShutdownSignal.SIGINT, onInterrupt);
    source.off(ShutdownSignal.SIGTERM, onTerminate);
    options.interrupt?.off(ShutdownSignal.SIGINT, onInterrupt);
  };
}
