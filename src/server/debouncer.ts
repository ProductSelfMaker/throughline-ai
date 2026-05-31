// src/server/debouncer.ts
type Task = () => void | Promise<void>;

/** Coalesces rapid schedule() calls into a single trailing run after `delayMs`. */
export class Debouncer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Task | null = null;

  constructor(private delayMs: number) {}

  schedule(task: Task): void {
    this.pending = task;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const task = this.pending;
    this.pending = null;
    if (task) void task();
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
  }
}
