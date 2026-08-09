"use client";

import { useEffect, useRef, useState } from "react";

import type {
  FailureStage,
  GenerateResponse,
  GenerateSuccess,
} from "@/lib/api-types";
import { EXAMPLE_TRANSCRIPT } from "@/lib/example-transcript";
import { CONFIDENCE_THRESHOLD, type Quiz } from "@/lib/schema";
import type { TranscriptFailure, TranscriptResult } from "@/lib/transcript-types";

/**
 * One human sentence per failure stage. Exhaustive by construction: the Record
 * type means a new FailureStage will not compile until it has copy here.
 */
const FAILURE_COPY: Record<FailureStage, string> = {
  bad_request: "Paste a transcript first — a few sentences at minimum.",
  network: "Couldn't reach the server. Check your connection and try again.",
  timeout: "Generation is taking too long — please try again.",
  llm_error: "The AI service didn't respond. This is usually temporary.",
  invalid_json: "The AI returned something we couldn't read. Trying again usually fixes it.",
  validation_error:
    "The AI's answer came back in the wrong shape. Trying again usually fixes it.",
  server_error: "Something went wrong on our end.",
};

/**
 * Caption fetching is best-effort, so every failure reason lands on the same
 * instruction: paste it yourself. `invalid_url` is the exception — the user's
 * next action there is fixing the URL, not reaching for the transcript.
 */
const FETCH_FALLBACK_COPY =
  "Couldn't fetch captions for this video — paste the transcript instead (YouTube: …more → Show transcript).";

const TRANSCRIPT_NOTICE: Record<TranscriptFailure["reason"], string> = {
  invalid_url:
    "That doesn't look like a YouTube link — check the URL, or paste the transcript below.",
  no_captions: FETCH_FALLBACK_COPY,
  unavailable: FETCH_FALLBACK_COPY,
  blocked: FETCH_FALLBACK_COPY,
  timeout: FETCH_FALLBACK_COPY,
  unknown: FETCH_FALLBACK_COPY,
};

/**
 * Above the route's own 70s budget so the server's specific error wins the race;
 * this is only a backstop for a request that never reaches the route at all.
 */
const CLIENT_TIMEOUT_MS = 80_000;

/** Likewise a backstop, above the transcript route's own 10s fetch timeout. */
const TRANSCRIPT_TIMEOUT_MS = 20_000;

/** Rotates so a long wait reads as progress rather than a stall. */
const LOADING_PHASES = ["Analyzing transcript…", "Generating questions…"];
const PHASE_ROTATE_MS = 15_000;

const MIN_TRANSCRIPT_CHARS = 50;

/**
 * Shared control styling. Kept as constants rather than a component wrapper —
 * three buttons do not justify an abstraction, and this keeps the markup honest
 * about what it renders.
 */
const BTN_BASE =
  "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-50";
/** The one accent-filled control on the page: the lowest-friction way in. */
const BTN_ACCENT = `${BTN_BASE} bg-accent text-accent-fg hover:bg-accent/90`;
const BTN_SOLID = `${BTN_BASE} bg-fg text-bg hover:bg-fg/85`;
const BTN_GHOST = `${BTN_BASE} border border-line bg-surface hover:bg-elevated`;

const CARD = "rounded-xl border border-line bg-surface";
const LABEL = "text-[11px] font-medium uppercase tracking-[0.12em] text-muted";

export default function Page() {
  const [url, setUrl] = useState("");
  const [transcript, setTranscript] = useState("");
  // Which URL's captions are already sitting in the textarea, so re-submitting
  // does not re-fetch what we just fetched.
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  // The video id, and the exact text we got for it. The quiz is only cached
  // against the video when the transcript is still verbatim what YouTube gave
  // us — otherwise an edited transcript would poison that video's cache entry.
  const [fetchedVideoId, setFetchedVideoId] = useState<string | null>(null);
  const [fetchedTranscript, setFetchedTranscript] = useState<string | null>(null);
  // Which URL's captions we already failed on, so a user who followed the
  // "paste instead" instruction is not sent back through the same failing fetch.
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const [notice, setNotice] = useState<TranscriptFailure["reason"] | null>(null);
  const [busy, setBusy] = useState<null | "fetching" | "generating">(null);
  const [result, setResult] = useState<GenerateResponse | null>(null);
  // Bumped per submission and used as <Result>'s key, so a new run remounts the
  // subtree and resets both the dismissed banner and any picked answers.
  const [runId, setRunId] = useState(0);
  const [phase, setPhase] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const loading = busy !== null;

  // Advance the loading copy once, then hold. Resets whenever a run ends, so the
  // next submission starts from the first phase again.
  useEffect(() => {
    if (busy !== "generating") {
      setPhase(0);
      return;
    }
    const timer = setTimeout(() => setPhase(1), PHASE_ROTATE_MS);
    return () => clearTimeout(timer);
  }, [busy]);

  // Never a dead end: when captions fail, put the cursor where the user can act.
  // Driven off the notice rather than called inline so it runs after the render
  // that re-enables the textarea.
  useEffect(() => {
    if (notice) textareaRef.current?.focus();
  }, [notice]);

  // Split from the submit handler so "Try again" and "Try an example" can re-run it.
  // Takes the text explicitly: setTranscript does not apply until the next render,
  // so the example button must pass its transcript rather than rely on state.
  async function run(
    text: string = transcript,
    opts: { force?: boolean; videoId?: string | null } = {},
  ) {
    // Validated here as well as server-side so an empty submit gets an instant
    // answer instead of a pointless round trip.
    if (text.trim().length < MIN_TRANSCRIPT_CHARS) {
      setResult({ ok: false, stage: "bad_request" });
      return;
    }

    // Passed explicitly straight after a fetch, since that state has not applied
    // yet; derived from state everywhere else.
    const videoId =
      opts.videoId !== undefined
        ? opts.videoId
        : text === fetchedTranscript
          ? fetchedVideoId
          : null;

    setBusy("generating");
    setResult(null);
    setRunId((n) => n + 1);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcript: text, video_id: videoId, force: opts.force }),
        signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
      });
      // A non-JSON body here means something upstream of the route failed
      // (proxy, crash, HTML error page) — treat it as a server error, not a parse bug.
      setResult((await res.json()) as GenerateResponse);
    } catch (err) {
      // These never reach the server, so the browser console is the only trace
      // available. It is devtools-only and never rendered.
      console.error("[generate] request failed:", err);
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      setResult({
        ok: false,
        stage: timedOut ? "timeout" : err instanceof TypeError ? "network" : "server_error",
      });
    } finally {
      // In `finally` so the spinner always stops, on every path above.
      setBusy(null);
    }
  }

  /**
   * Returns the fetched transcript, or null when the user has been degraded to
   * the paste flow. Deliberately swallows every failure into a notice: this is a
   * best-effort convenience, and nothing here should ever block the paste path.
   */
  async function fetchCaptions(
    target: string,
  ): Promise<{ text: string; videoId: string } | null> {
    setBusy("fetching");
    setResult(null);
    try {
      const res = await fetch("/api/transcript", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: target }),
        signal: AbortSignal.timeout(TRANSCRIPT_TIMEOUT_MS),
      });
      const data = (await res.json()) as TranscriptResult;
      if (!data.ok) return degrade(target, data.reason);

      setTranscript(data.transcript);
      setFetchedFor(target);
      setFetchedVideoId(data.video_id);
      setFetchedTranscript(data.transcript);
      return { text: data.transcript, videoId: data.video_id };
    } catch (err) {
      // Never reached the route, so the browser console is the only trace.
      console.error("[transcript] request failed:", err);
      return degrade(target, "unknown");
    }
  }

  function degrade(target: string, reason: TranscriptFailure["reason"]): null {
    setBusy(null);
    setFailedFor(target);
    setNotice(reason);
    return null;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);

    const target = url.trim();
    const pastedEnough = transcript.trim().length >= MIN_TRANSCRIPT_CHARS;
    // Skip the fetch when there is no URL, when we already have this URL's
    // captions, or when this URL failed and the user did what we asked and
    // pasted. That last case is the whole point of the fallback: following the
    // instruction must not send you back through the fetch that just failed.
    // A failed URL with an empty textarea still retries — blocks are often transient.
    if (!target || target === fetchedFor || (target === failedFor && pastedEnough)) {
      void run(transcript);
      return;
    }

    const fetched = await fetchCaptions(target);
    // null means the notice is already up and the textarea has focus.
    if (fetched !== null) void run(fetched.text, { videoId: fetched.videoId });
  }

  // Fills the textarea and submits in one click. The transcript is passed through
  // rather than read back from state, which has not updated yet at this point.
  // Clears the URL so the example never triggers a caption fetch.
  function loadExample() {
    setUrl("");
    setFetchedFor(null);
    setFailedFor(null);
    setFetchedVideoId(null);
    setFetchedTranscript(null);
    setNotice(null);
    setTranscript(EXAMPLE_TRANSCRIPT);
    void run(EXAMPLE_TRANSCRIPT);
  }

  const chars = transcript.trim().length;

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-14 sm:py-20">
      <header className="space-y-5">
        <h1 className="text-[2rem] font-semibold leading-[1.1] tracking-tight sm:text-5xl">
          Watching isn&apos;t learning.
        </h1>
        <p className="max-w-xl text-[15px] leading-relaxed text-muted sm:text-base">
          This tool tests whether you actually understood a video — every question
          forces you to apply concepts to NEW situations, never to recall the
          video&apos;s own examples. Paste a transcript (or try the example) and find
          out what stuck.
        </p>
        {/* Accent-filled, unlike every other control: with an empty textarea this
            is the lowest-friction way in, so it carries the visual weight. */}
        <button
          type="button"
          className={`${BTN_ACCENT} group`}
          disabled={loading}
          onClick={loadExample}
        >
          Try an example
          <span
            aria-hidden
            className="transition-transform group-hover:translate-x-0.5"
          >
            →
          </span>
        </button>
      </header>

      <form onSubmit={onSubmit} className="mt-12">
        {/* URL, transcript and submit share one panel so they read as a single
            control — the URL is the fast path, the textarea the guaranteed one. */}
        <div className="overflow-hidden rounded-xl border border-line bg-surface transition-colors focus-within:border-accent/50">
          <div className="border-b border-line px-4 py-3.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <label htmlFor="yt-url" className={LABEL}>
                YouTube URL
              </label>
              <span className="text-xs text-muted">
                Best effort — paste always works.
              </span>
            </div>
            {/* type="text", not type="url": native URL validation rejects a
                scheme-less "youtube.com/watch?v=…", which we accept. */}
            <input
              id="yt-url"
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              className="mt-2.5 block w-full bg-transparent text-sm outline-none placeholder:text-muted"
              placeholder="https://www.youtube.com/watch?v=…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>

          {notice && (
            <div className="flex items-start gap-2.5 border-b border-line bg-warn/[0.07] px-4 py-3">
              <span className="mt-0.5 shrink-0 text-warn">
                <AlertIcon />
              </span>
              <p className="text-sm leading-relaxed text-fg/90">
                {TRANSCRIPT_NOTICE[notice]}
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4 pt-3.5">
            <label htmlFor="transcript" className={LABEL}>
              Transcript
            </label>
            {fetchedFor && transcript && (
              <span className="text-xs text-muted">Filled from captions</span>
            )}
          </div>
          <textarea
            id="transcript"
            ref={textareaRef}
            className="block h-44 w-full resize-none bg-transparent px-4 pb-4 pt-2.5 text-sm leading-relaxed outline-none placeholder:text-muted sm:h-52"
            placeholder="Paste raw transcript here…"
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
          />
          <div className="flex items-center justify-between gap-3 border-t border-line bg-elevated px-4 py-3">
            <span className="text-xs tabular-nums text-muted">
              {chars > 0
                ? `${chars.toLocaleString()} characters`
                : `${MIN_TRANSCRIPT_CHARS} characters minimum`}
            </span>
            {/* Only disabled while in flight. A too-short transcript is allowed
                through so the user gets an explanation, not a dead button. */}
            <button type="submit" className={BTN_SOLID} disabled={loading}>
              {busy === "fetching"
                ? "Fetching…"
                : busy === "generating"
                  ? "Generating…"
                  : "Generate quiz"}
            </button>
          </div>
        </div>
      </form>

      <div className="mt-8">
        {busy === "fetching" && (
          <Loading
            label="Fetching captions…"
            hint="If this doesn't work, you can paste the transcript instead."
          />
        )}
        {busy === "generating" && (
          <Loading
            label={LOADING_PHASES[phase]}
            hint="This usually takes 20–30 seconds."
          />
        )}

        {result && !result.ok && (
          <div className={`${CARD} border-bad/30 bg-bad/[0.04] p-6`}>
            <h2 className="text-base font-semibold tracking-tight text-bad">
              Couldn&apos;t generate a quiz
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              {FAILURE_COPY[result.stage]}
            </p>
            <button
              type="button"
              className={`${BTN_GHOST} mt-5`}
              disabled={loading}
              // Retries generation with whatever is in the textarea; it never
              // re-fetches captions, which have already succeeded by this point.
              onClick={() => void run(transcript)}
            >
              Try again
            </button>
          </div>
        )}

        {result?.ok && (
          <div className="space-y-6">
            {/* Deliberately quiet: a cache hit is an implementation detail, but
                one the user needs if they want a different set of questions. */}
            {result.cached && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-elevated px-4 py-2.5">
                <span className="flex items-center gap-2 text-xs text-muted">
                  <CacheIcon />
                  Served from an earlier run
                </span>
                <button
                  type="button"
                  className="rounded text-xs font-medium text-muted underline underline-offset-4 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50"
                  disabled={loading}
                  onClick={() => void run(transcript, { force: true })}
                >
                  Regenerate
                </button>
              </div>
            )}
            <Result key={runId} result={result} />
          </div>
        )}
      </div>
    </main>
  );
}

/* aria-live so the wait, and the phase change, are announced and not just shown. */
function Loading({ label, hint }: { label: string; hint: string }) {
  return (
    <div role="status" aria-live="polite" className={`${CARD} p-6`}>
      <div className="flex items-center gap-3">
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
        </span>
        <span className="text-sm font-medium">{label}</span>
      </div>
      <p className="mt-2 pl-5 text-sm text-muted">{hint}</p>
      {/* Sweeps rather than filling: we cannot estimate completion, and a fake
          percentage that stalls at 90% is worse than an honest indeterminate bar. */}
      <div className="mt-5 h-1 w-full overflow-hidden rounded-full bg-elevated">
        <div className="animate-sweep h-full w-1/4 rounded-full bg-accent" />
      </div>
    </div>
  );
}

function Result({ result }: { result: GenerateSuccess }) {
  const { data } = result;
  const [bannerDismissed, setBannerDismissed] = useState(false);

  // The gate is deliberately soft: low confidence never rejects, it only caveats.
  const lowConfidence = data.confidence < CONFIDENCE_THRESHOLD;
  // Confidently non-educational is the only rejection.
  const rejected = !data.is_educational && !lowConfidence;

  // `!data.quiz` also lands here: with nothing to render, this is the only sane fallback.
  if (rejected || !data.quiz) {
    return (
      <div className={`${CARD} p-6`}>
        <h2 className="text-base font-semibold tracking-tight">
          {rejected ? "Out of scope" : "No quiz generated"}
        </h2>
        {rejected ? (
          <>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              This doesn&apos;t appear to be educational content.
            </p>
            <p className="mt-4 border-l-2 border-line pl-4 text-sm leading-relaxed text-fg/80">
              {data.reason}
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Couldn&apos;t generate a quiz for this content — try another video.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {lowConfidence && !bannerDismissed && (
        <div className="flex items-start gap-3 rounded-xl border border-warn/30 bg-warn/[0.07] px-4 py-3.5">
          <p className="grow text-sm leading-relaxed text-fg/90">
            This content is loosely structured — quiz quality may be uneven.
          </p>
          <button
            type="button"
            aria-label="Dismiss"
            className="-mr-1 -mt-0.5 shrink-0 rounded-md p-1 text-muted transition-colors hover:bg-warn/15 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            onClick={() => setBannerDismissed(true)}
          >
            <XIcon />
          </button>
        </div>
      )}
      <QuizView quiz={data.quiz} />
    </div>
  );
}

function QuizView({ quiz }: { quiz: Quiz }) {
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [checked, setChecked] = useState(false);

  const total = quiz.questions.length;
  const answered = Object.keys(answers).length;
  const score = quiz.questions.reduce(
    (n, q, i) => n + (answers[i] === q.correct_index ? 1 : 0),
    0,
  );

  return (
    <div className="space-y-6">
      {/* Before checking, progress is the useful number; after, it is the score.
          They never appear at once, so the page never shows two progress bars. */}
      {!checked ? (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <span className={LABEL}>Quiz</span>
            <span className="text-xs tabular-nums text-muted">
              {answered} of {total} answered
            </span>
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-elevated">
            <div
              className="h-full rounded-full bg-accent/60 transition-[width] duration-300"
              style={{ width: `${(answered / total) * 100}%` }}
            />
          </div>
        </div>
      ) : (
        <ScoreCard score={score} total={total} />
      )}

      <div className="space-y-4">
        {quiz.questions.map((q, i) => (
          <div key={i} className={`${CARD} p-5`}>
            <div className="flex gap-3">
              <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md bg-elevated text-xs font-medium tabular-nums text-muted">
                {i + 1}
              </span>
              <p className="text-[15px] font-medium leading-relaxed">{q.question}</p>
            </div>

            <div className="mt-4 space-y-2">
              {q.options.map((opt, j) => {
                const picked = answers[i] === j;
                const correct = j === q.correct_index;
                return (
                  <label
                    key={j}
                    className={`flex items-start gap-3 rounded-lg border px-3.5 py-3 text-sm leading-relaxed transition-colors ${optionClass(
                      { checked, picked, correct },
                    )}`}
                  >
                    {/* Visually hidden but still the real radio: arrow-key group
                        navigation keeps working. The ring moves to the sibling
                        mark so keyboard focus stays visible. */}
                    <input
                      type="radio"
                      name={`q${i}`}
                      className="peer sr-only"
                      checked={picked}
                      disabled={checked}
                      onChange={() => setAnswers((a) => ({ ...a, [i]: j }))}
                    />
                    <span className="mt-0.5 shrink-0 rounded-full peer-focus-visible:ring-2 peer-focus-visible:ring-accent/60 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface">
                      <OptionMark checked={checked} picked={picked} correct={correct} />
                    </span>
                    <span>{opt}</span>
                  </label>
                );
              })}
            </div>

            {checked && (
              <div className="mt-4 rounded-lg bg-elevated px-4 py-3">
                <div className={LABEL}>Explanation</div>
                <p className="mt-1.5 text-sm leading-relaxed text-fg/85">
                  {q.explanation}
                </p>
              </div>
            )}
          </div>
        ))}
      </div>

      {!checked ? (
        <button type="button" className={BTN_SOLID} onClick={() => setChecked(true)}>
          Check answers
        </button>
      ) : (
        quiz.deeper_topics.length > 0 && (
          <section>
            <h2 className={LABEL}>Go deeper</h2>
            <ul className={`${CARD} mt-3 divide-y divide-line`}>
              {quiz.deeper_topics.map((t, i) => (
                <li key={i} className="flex gap-3 px-4 py-3.5 text-sm leading-relaxed">
                  <span aria-hidden className="shrink-0 text-accent">
                    →
                  </span>
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </section>
        )
      )}
    </div>
  );
}

function ScoreCard({ score, total }: { score: number; total: number }) {
  return (
    <div className={`${CARD} p-6`}>
      <div className={LABEL}>Score</div>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        <span className="text-5xl font-semibold tabular-nums tracking-tight">
          {score}
        </span>
        <span className="text-xl font-medium tabular-nums text-muted">/ {total}</span>
      </div>
      <div className="mt-5 h-1.5 w-full overflow-hidden rounded-full bg-elevated">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-700"
          style={{ width: `${(score / total) * 100}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Option styling in one place. Before checking, the only signal is which option
 * is selected; after, correctness outranks selection — the right answer is always
 * marked, and a wrong pick is marked as wrong.
 */
function optionClass({
  checked,
  picked,
  correct,
}: {
  checked: boolean;
  picked: boolean;
  correct: boolean;
}): string {
  if (!checked) {
    return picked
      ? "cursor-pointer border-accent bg-accent/[0.07]"
      : "cursor-pointer border-line hover:border-muted/40 hover:bg-elevated";
  }
  if (correct) return "border-ok/40 bg-ok/[0.07]";
  if (picked) return "border-bad/40 bg-bad/[0.06]";
  return "border-line opacity-60";
}

function OptionMark({
  checked,
  picked,
  correct,
}: {
  checked: boolean;
  picked: boolean;
  correct: boolean;
}) {
  if (checked && correct) return <CheckIcon className="text-ok" />;
  if (checked && picked) return <XIcon className="text-bad" />;
  // Unanswered and after-the-fact wrong options share the same empty dot: neither
  // needs a verdict glyph.
  return (
    <span
      className={`block h-4 w-4 rounded-full border-2 transition-colors ${
        picked ? "border-accent bg-accent" : "border-line"
      }`}
    />
  );
}

function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`h-4 w-4 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 8.5 6.5 12 13 4" />
    </svg>
  );
}

function CacheIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <ellipse cx="8" cy="4" rx="5.5" ry="2.25" />
      <path d="M2.5 4v8c0 1.24 2.46 2.25 5.5 2.25s5.5-1.01 5.5-2.25V4" />
      <path d="M2.5 8c0 1.24 2.46 2.25 5.5 2.25s5.5-1.01 5.5-2.25" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 4.75v3.75" />
      <path d="M8 11.25h.008" />
    </svg>
  );
}

function XIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`h-4 w-4 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
