import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { jobs } from "../db/schema.js";
import { logger } from "../lib/logger.js";

export type JobHandler = (payload: unknown, job: { id: number; attempts: number }) => Promise<void>;

type ClaimedJob = { id: number; type: string; key: string; payload: unknown; attempts: number; max_attempts: number };

/**
 * Minimal durable job queue on Postgres (`FOR UPDATE SKIP LOCKED`).
 *
 * - `enqueue(type, key, payload, { delayMs, debounce })`: with `debounce`, a pending job with the
 *   same (type, key) is pushed back instead of duplicated — this is how a burst of client
 *   messages produces a single reply.
 * - Jobs sharing a key never run concurrently (per-conversation serialisation).
 * - Failed jobs are retried with exponential backoff; stuck jobs are recovered.
 */
export class JobQueue {
  private handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | undefined;
  private running = 0;
  private stopping = false;

  constructor(
    private readonly db: Db,
    private readonly opts: { concurrency?: number; pollMs?: number; staleAfterMs?: number } = {},
  ) {}

  register(type: string, handler: JobHandler): this {
    this.handlers.set(type, handler);
    return this;
  }

  async enqueue(type: string, key: string, payload: unknown, opts: { delayMs?: number; debounce?: boolean; maxAttempts?: number } = {}): Promise<void> {
    const runAt = new Date(Date.now() + (opts.delayMs ?? 0));
    const insert = this.db.insert(jobs).values({ type, key, payload, runAt, maxAttempts: opts.maxAttempts ?? 5 });
    await (opts.debounce
      ? insert.onConflictDoUpdate({
          target: [jobs.type, jobs.key],
          targetWhere: sql`status = 'pending'`,
          set: { runAt, payload },
        })
      : insert.onConflictDoNothing());
  }

  /** Claims and runs due jobs once. Returns the number of jobs processed (used by tests). */
  async tick(): Promise<number> {
    const capacity = (this.opts.concurrency ?? 4) - this.running;
    if (capacity <= 0) return 0;
    const types = [...this.handlers.keys()];
    if (types.length === 0) return 0;

    const staleMs = this.opts.staleAfterMs ?? 5 * 60_000;
    // Recover jobs whose worker died mid-run.
    await this.db.execute(sql`
      UPDATE jobs SET status = 'pending', locked_at = NULL
      WHERE status = 'running' AND locked_at < now() - (${staleMs} * interval '1 millisecond')
        AND NOT EXISTS (SELECT 1 FROM jobs p WHERE p.type = jobs.type AND p.key = jobs.key AND p.status = 'pending')`);

    const { rows } = await this.db.execute<ClaimedJob>(sql`
      UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
      WHERE id IN (
        SELECT j.id FROM jobs j
        WHERE j.status = 'pending' AND j.run_at <= now()
          AND j.type IN (${sql.join(types.map((t) => sql`${t}`), sql`, `)})
          AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.type = j.type AND r.key = j.key AND r.status = 'running')
        ORDER BY j.run_at
        LIMIT ${capacity}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, type, key, payload, attempts, max_attempts`);

    await Promise.all(rows.map((job) => this.run(job)));
    return rows.length;
  }

  private async run(job: ClaimedJob): Promise<void> {
    const handler = this.handlers.get(job.type);
    this.running++;
    try {
      if (!handler) throw new Error(`No handler for job type ${job.type}`);
      await handler(job.payload, { id: job.id, attempts: job.attempts });
      await this.db.execute(sql`UPDATE jobs SET status = 'done', locked_at = NULL, last_error = NULL WHERE id = ${job.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const final = job.attempts >= job.max_attempts;
      const backoffMs = Math.min(2 ** job.attempts * 1_000, 10 * 60_000);
      logger.warn({ jobId: job.id, type: job.type, attempts: job.attempts, err: message }, final ? "Job failed permanently" : "Job failed, will retry");
      if (final) {
        await this.db.execute(sql`UPDATE jobs SET status = 'failed', locked_at = NULL, last_error = ${message} WHERE id = ${job.id}`);
      } else {
        // If a newer pending job exists for the same key (debounce), it supersedes this retry.
        await this.db.execute(sql`
          UPDATE jobs SET
            status = CASE WHEN EXISTS (SELECT 1 FROM jobs p WHERE p.type = jobs.type AND p.key = jobs.key AND p.status = 'pending' AND p.id <> jobs.id) THEN 'done'::job_status ELSE 'pending'::job_status END,
            locked_at = NULL, last_error = ${message},
            run_at = now() + (${backoffMs} * interval '1 millisecond')
          WHERE id = ${job.id}`);
      }
    } finally {
      this.running--;
    }
  }

  start(): void {
    this.stopping = false;
    const loop = async () => {
      if (this.stopping) return;
      try {
        await this.tick();
      } catch (err) {
        logger.error({ err }, "Queue tick failed");
      }
      this.timer = setTimeout(loop, this.opts.pollMs ?? 500);
    };
    void loop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    while (this.running > 0) await new Promise((r) => setTimeout(r, 50));
  }

  /** Deletes finished jobs older than `days`. */
  async prune(days = 7): Promise<void> {
    await this.db.execute(sql`DELETE FROM jobs WHERE status IN ('done','failed') AND created_at < now() - (${days} * interval '1 day')`);
  }
}
