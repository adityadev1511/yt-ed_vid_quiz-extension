import {
  YoutubeTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptTooManyRequestError,
  YoutubeTranscriptVideoUnavailableError,
} from "youtube-transcript";

/**
 * Caption fetching. Best-effort by design: YouTube blocks datacenter IPs
 * aggressively, so this failing in production is an expected outcome, not a bug.
 * Every failure path ends at the paste fallback in the UI.
 */

export type TranscriptFailureReason =
  | "no_captions" // video exists, captions are off or absent
  | "unavailable" // private, deleted, age-gated, or bad ID
  | "blocked" // YouTube rate-limited or refused our IP
  | "timeout"
  | "unknown";

export class TranscriptError extends Error {
  constructor(
    readonly reason: TranscriptFailureReason,
    readonly detail?: string,
  ) {
    super(`transcript fetch failed: ${reason}`);
    this.name = "TranscriptError";
  }
}

/**
 * Well under the LLM gateway's budget: this runs before generation even starts,
 * and a slow caption fetch should drop to the paste fallback rather than eat
 * into the time available for the actual quiz.
 */
const FETCH_TIMEOUT_MS = 10_000;

/** Below this, whatever came back is too thin to build a quiz from. */
const MIN_USEFUL_CHARS = 50;

export type FetchedTranscript = {
  text: string;
  /** Caption track language, when the library reports one. */
  lang?: string;
};

export async function fetchTranscript(videoId: string): Promise<FetchedTranscript> {
  // The library exposes no signal option, but it does let us supply fetch —
  // so the timeout lands on the actual socket instead of racing a promise that
  // would keep running after we stopped waiting for it.
  //
  // Supplying fetch also lets us see the upstream status. The library collapses
  // every failure into "no transcripts are available", which hides the one
  // distinction that actually matters operationally: a video genuinely without
  // captions, versus YouTube serving us its 429 "Sorry..." page. Only the second
  // is a reason to reconsider shipping this feature.
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let refusedStatus: number | null = null;
  const timedFetch: typeof globalThis.fetch = async (input, init) => {
    const res = await globalThis.fetch(input, { ...init, signal });
    if (!res.ok && refusedStatus === null) refusedStatus = res.status;
    return res;
  };

  let segments;
  try {
    segments = await YoutubeTranscript.fetchTranscript(videoId, { fetch: timedFetch });
  } catch (err) {
    const detail = refusedStatus
      ? `${errorText(err)} (upstream HTTP ${refusedStatus})`
      : errorText(err);
    throw new TranscriptError(classify(err, refusedStatus), detail);
  }

  // Caption cues arrive as timed fragments; the LLM wants prose. Joining on a
  // space is enough — cue boundaries are not sentence boundaries, so anything
  // fancier would invent punctuation that was never there.
  const text = segments
    .map((s) => s.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length < MIN_USEFUL_CHARS) {
    throw new TranscriptError("no_captions", `only ${text.length} chars returned`);
  }

  return { text, lang: segments[0]?.lang };
}

function classify(err: unknown, refusedStatus: number | null): TranscriptFailureReason {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return "timeout";
  }
  // Checked before the library's own error classes on purpose: a 429 from the
  // timedtext endpoint surfaces as NotAvailableError, which would otherwise be
  // logged as "this video has no captions" when we were simply refused.
  if (refusedStatus === 429 || refusedStatus === 403) return "blocked";
  if (err instanceof YoutubeTranscriptTooManyRequestError) return "blocked";
  if (err instanceof YoutubeTranscriptVideoUnavailableError) return "unavailable";
  if (
    err instanceof YoutubeTranscriptDisabledError ||
    err instanceof YoutubeTranscriptNotAvailableError ||
    err instanceof YoutubeTranscriptNotAvailableLanguageError
  ) {
    return "no_captions";
  }
  // The library throws a bare YoutubeTranscriptError for anything it cannot
  // place, including the CAPTCHA page YouTube serves to flagged IPs.
  if (err instanceof Error && /captcha|too many|429|forbidden|403/i.test(err.message)) {
    return "blocked";
  }
  return "unknown";
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
