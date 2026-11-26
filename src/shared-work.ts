/** Wait for a shared result without giving a caller ownership of the upstream signal. */
export function waitWithSignal<T>(result: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return result;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void result.then(
      value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

export class SharedWork<T> {
  private readonly controller = new AbortController();
  private consumers = 0;
  private finished = false;
  readonly result: Promise<T>;

  constructor(run: (signal: AbortSignal) => Promise<T>) {
    this.result = Promise.resolve().then(() => {
      this.signal.throwIfAborted();
      return run(this.signal);
    }).finally(() => { this.finished = true; });
  }

  get signal(): AbortSignal { return this.controller.signal; }

  retain(signal?: AbortSignal): () => void {
    signal?.throwIfAborted();
    this.consumers++;
    let released = false;
    const release = () => {
      if (released) return;
      signal?.removeEventListener('abort', release);
      released = true;
      this.consumers--;
      if (!this.consumers && !this.finished) this.controller.abort();
    };
    signal?.addEventListener('abort', release, { once: true });
    return release;
  }

  async wait(signal?: AbortSignal): Promise<T> {
    const release = this.retain(signal);
    try { return await waitWithSignal(this.result, signal); }
    finally { release(); }
  }
}
