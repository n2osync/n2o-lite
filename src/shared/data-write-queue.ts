import type { createLogger } from './logger';
import { getErrorMessage } from './errors';

type ErrorLogger = Pick<ReturnType<typeof createLogger>, 'error'>;

/**
 * Serialized read-modify-write of a shared data blob (the plugin's data.json).
 *
 * saveSettings and the license save both mutate the same blob; running them
 * concurrently caused a TOCTOU where one overwrote the other's key (lost
 * settings, or a lost license). Chaining every mutation through one queue makes
 * each load-modify-save atomic.
 *
 * A mutator rejection is delivered to an awaiting caller via the returned
 * promise AND logged - never swallowed silently (#1796). The queue stays alive
 * after a failure so later writes still run; without the log, a fire-and-forget
 * caller's failed write would vanish with no trace.
 */
export class DataWriteQueue {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly load: () => Promise<Record<string, unknown> | null>,
    private readonly save: (data: Record<string, unknown>) => Promise<void>,
    private readonly log: ErrorLogger,
  ) {}

  update(mutator: (data: Record<string, unknown>) => void | Promise<void>): Promise<void> {
    const run = this.queue.then(async () => {
      const data = (await this.load()) ?? {};
      await mutator(data);
      await this.save(data);
    });
    // Keep the chain alive even if one mutator rejects, so later writes still
    // run - but LOG the failed write instead of swallowing it silently.
    this.queue = run.catch((err) => {
      this.log.error(
        `A queued data.json write failed; later writes will continue: ${getErrorMessage(err)}`,
        err,
      );
    });
    return run;
  }
}
