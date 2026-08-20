/**
 * Global write mutex (design doc §11): the ChatGPT Desktop GUI is a
 * single shared mutable device; all mutating operations are serialized.
 */
export class Mutex {
  private chain: Promise<void> = Promise.resolve();
  private holders = 0;

  get busy(): boolean {
    return this.holders > 0;
  }

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((resolve) => (release = resolve));
    return prev.then(async () => {
      this.holders += 1;
      try {
        return await fn();
      } finally {
        this.holders -= 1;
        release();
      }
    });
  }
}
