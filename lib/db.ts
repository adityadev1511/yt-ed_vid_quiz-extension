import { createHash } from "node:crypto";

import { Pool } from "pg";

import { LlmResponseSchema, type LlmResponse } from "./schema";

/**
 * Quiz cache. One table, no ORM, and deliberately optional: every function here
 * returns null rather than throwing, so a missing or unreachable database
 * degrades the app to exactly the stateless behaviour it had before this file
 * existed. Nothing in the generate path may block on the cache.
 */

/**
 * Short on purpose. These bound how long a sick database can delay a request
 * that would otherwise succeed without it — the cache is an optimisation, and
 * an optimisation that adds seconds to a miss is a regression.
 *
 * Connect allows 5s rather than 2s because Neon scales to zero when idle and a
 * cold start can exceed 2s — which would trip the breaker on the first request
 * after every quiet spell, skipping the cache exactly when it was about to work.
 */
const CONNECT_TIMEOUT_MS = 5_000;
const QUERY_TIMEOUT_MS = 3_000;

/**
 * After a failure, stop calling the database for this long.
 *
 * Without it, a database that hangs rather than refuses costs every single
 * request the full connect timeout twice — once on the read, once on the write —
 * which measured as ~6s added to every generation. The breaker turns that into
 * one slow request per cooldown window instead of a permanent tax.
 */
const BREAKER_COOLDOWN_MS = 30_000;

/**
 * Next's dev server re-evaluates modules on hot reload, which would leak a new
 * pool per edit until Postgres refuses connections. Stashing it on globalThis is
 * the standard escape hatch.
 */
const globalForDb = globalThis as unknown as {
  quizPool?: Pool | null;
  quizDbDownUntil?: number;
};

/** True while the breaker is open, i.e. a recent call failed and we are backing off. */
function breakerOpen(): boolean {
  return (globalForDb.quizDbDownUntil ?? 0) > Date.now();
}

function recordFailure(): void {
  globalForDb.quizDbDownUntil = Date.now() + BREAKER_COOLDOWN_MS;
}

function recordSuccess(): void {
  globalForDb.quizDbDownUntil = 0;
}

/**
 * A unique violation is a healthy database answering correctly; a timeout is not.
 * Only the second should open the breaker — otherwise one conflicting row would
 * disable the cache for everyone for the next 30 seconds.
 *
 * pg tags SQL errors with a 5-character SQLSTATE. Anything without one
 * (ETIMEDOUT, ECONNREFUSED, ENOTFOUND, or a bare timeout Error) is connectivity.
 */
function isConnectivityError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return typeof code !== "string" || code.length !== 5;
}

function getPool(): Pool | null {
  if (globalForDb.quizPool !== undefined) return globalForDb.quizPool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn("[db] DATABASE_URL is not set — running without the quiz cache.");
    globalForDb.quizPool = null;
    return null;
  }

  const pool = new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  });

  // Without this, an error on an idle client is an unhandled 'error' event and
  // takes the whole process down — a database blip would become an outage.
  pool.on("error", (err) => {
    console.error("[db] idle client error:", err.message);
  });

  globalForDb.quizPool = pool;
  return pool;
}

/** Stable identity for a pasted transcript. Trimmed so trailing whitespace is not a new quiz. */
export function hashTranscript(transcript: string): string {
  return createHash("sha256").update(transcript.trim(), "utf8").digest("hex");
}

export type CachedQuiz = {
  data: LlmResponse;
  model_used: string;
};

/**
 * Cache read. Matches on either key so the two entry points share one cache: a
 * transcript pasted by hand hits the same row a URL fetch created, and vice versa.
 * A video-ID match wins when both are present, since it is the stronger identity.
 */
export async function lookupQuiz(
  transcriptHash: string,
  videoId: string | null,
): Promise<CachedQuiz | null> {
  const pool = getPool();
  if (!pool || breakerOpen()) return null;

  try {
    const { rows } = await pool.query(
      `select quiz_json, model_used
         from quizzes
        where transcript_hash = $1
           or ($2::text is not null and yt_video_id = $2)
        order by (yt_video_id is not distinct from $2) desc
        limit 1`,
      [transcriptHash, videoId],
    );
    recordSuccess();
    if (rows.length === 0) return null;

    // Re-validated rather than trusted: a row written by an older schema version
    // would otherwise render as a broken quiz. A stale shape is a cache miss.
    const parsed = LlmResponseSchema.safeParse(rows[0].quiz_json);
    if (!parsed.success) {
      console.warn("[db] cached row failed validation, treating as a miss");
      return null;
    }
    return { data: parsed.data, model_used: rows[0].model_used };
  } catch (err) {
    if (isConnectivityError(err)) recordFailure();
    console.error("[db] cache lookup failed, continuing without it:", errorText(err));
    return null;
  }
}

/**
 * Cache write. Upserts on transcript_hash so Regenerate replaces the stored quiz
 * rather than erroring. Returns nothing: a failed write must never fail a request
 * whose quiz was generated successfully.
 */
export async function saveQuiz(params: {
  transcriptHash: string;
  videoId: string | null;
  data: LlmResponse;
  modelUsed: string;
}): Promise<void> {
  const pool = getPool();
  // The breaker matters most here: this runs after the quiz already exists, so
  // every second spent failing to store it is a second the user waits for nothing.
  if (!pool || breakerOpen()) return;

  let client;
  try {
    client = await pool.connect();
    await client.query("begin");

    // One video keeps one quiz. A video whose transcript changed at all — new
    // auto-captions, an edit, a corrupted row being replaced — arrives with a new
    // hash, so the upsert below would miss its conflict target and instead hit the
    // yt_video_id unique constraint. The write would be lost every time, leaving
    // that video permanently uncacheable. Clearing the stale row first is what
    // makes the cache self-healing.
    if (params.videoId) {
      await client.query(
        `delete from quizzes where yt_video_id = $1 and transcript_hash <> $2`,
        [params.videoId, params.transcriptHash],
      );
    }

    await client.query(
      `insert into quizzes
         (yt_video_id, transcript_hash, quiz_json, model_used, is_educational, edu_confidence)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (transcript_hash) do update set
         quiz_json      = excluded.quiz_json,
         model_used     = excluded.model_used,
         is_educational = excluded.is_educational,
         edu_confidence = excluded.edu_confidence,
         created_at     = now(),
         -- Never drop a known video id by re-saving the same transcript from the paste flow.
         yt_video_id    = coalesce(excluded.yt_video_id, quizzes.yt_video_id)`,
      [
        params.videoId,
        params.transcriptHash,
        JSON.stringify(params.data),
        params.modelUsed,
        params.data.is_educational,
        params.data.confidence,
      ],
    );

    await client.query("commit");
    recordSuccess();
  } catch (err) {
    await client?.query("rollback").catch(() => {});
    if (isConnectivityError(err)) recordFailure();
    console.error("[db] cache write failed, quiz served anyway:", errorText(err));
  } finally {
    // Must always return the client or the pool leaks connections until it stalls.
    client?.release();
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
