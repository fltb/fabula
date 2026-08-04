// ============================================================================
// Concurrency pool — execute async tasks with bounded parallelism
// ============================================================================
//
// Used by the render pipeline to render multiple scenes in parallel without
// slamming the LLM provider. Like p-limit / p-queue but minimal.
//
// Usage:
//   const pool = new ConcurrencyPool(5);
//   const results = await Promise.all(
//     items.map((item) => pool.run(() => processItem(item)))
//   );
// ============================================================================

export class ConcurrencyPool {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (limit < 1) throw new Error('ConcurrencyPool: limit must be >= 1');
  }

  /**
   * Run `fn` when a slot is available. Returns the promise of fn's result.
   */
  run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task = () => {
        this.active++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this._drain();
          });
      };
      this.queue.push(task);
      this._drain();
    });
  }

  /**
   * Run an array of inputs through `fn` with bounded parallelism.
   * Returns results in the same order as inputs.
   */
  async all<T, R>(items: T[], fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    return Promise.all(items.map((item, i) => this.run(() => fn(item, i))));
  }

  private _drain(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next === undefined) break;
      next();
    }
  }

  /** Current active task count. */
  get concurrency(): number {
    return this.active;
  }

  /** Pending task count. */
  get pending(): number {
    return this.queue.length;
  }
}
