/**
 * Run timeout utility for graceful shutdown before Cloud Function hard limit.
 *
 * The Cloud Function has a 9-minute hard timeout. This utility tracks elapsed
 * time and signals when the run should stop to allow graceful state saving.
 */

import { RUN_TIMEOUT_MS } from '../config.js';

export class RunTimer {
  private readonly startTime: number;
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = RUN_TIMEOUT_MS) {
    this.startTime = Date.now();
    this.timeoutMs = timeoutMs;
  }

  /** Returns elapsed time in milliseconds since the run started */
  elapsed(): number {
    return Date.now() - this.startTime;
  }

  /** Returns true if the run has exceeded the timeout threshold */
  isExpired(): boolean {
    return this.elapsed() >= this.timeoutMs;
  }

  /** Returns remaining time in milliseconds */
  remaining(): number {
    return Math.max(0, this.timeoutMs - this.elapsed());
  }
}
