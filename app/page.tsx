"use client";

import { useEffect, useState } from "react";

import type {
  FailureStage,
  GenerateResponse,
  GenerateSuccess,
} from "@/lib/api-types";
import { CONFIDENCE_THRESHOLD, type Quiz } from "@/lib/schema";

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
 * Above the route's own 70s budget so the server's specific error wins the race;
 * this is only a backstop for a request that never reaches the route at all.
 */
const CLIENT_TIMEOUT_MS = 80_000;

/** Rotates so a long wait reads as progress rather than a stall. */
const LOADING_PHASES = ["Analyzing transcript…", "Generating questions…"];
const PHASE_ROTATE_MS = 15_000;

const MIN_TRANSCRIPT_CHARS = 50;

export default function Page() {
  const [transcript, setTranscript] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<GenerateResponse | null>(null);
  // Bumped per submission and used as <Result>'s key, so a new run remounts the
  // subtree and resets both the dismissed banner and any picked answers.
  const [runId, setRunId] = useState(0);
  const [phase, setPhase] = useState(0);

  // Advance the loading copy once, then hold. Resets whenever a run ends, so the
  // next submission starts from the first phase again.
  useEffect(() => {
    if (!loading) {
      setPhase(0);
      return;
    }
    const timer = setTimeout(() => setPhase(1), PHASE_ROTATE_MS);
    return () => clearTimeout(timer);
  }, [loading]);

  // Split from the submit handler so the "Try again" button can re-run it.
  async function run() {
    // Validated here as well as server-side so an empty submit gets an instant
    // answer instead of a pointless round trip.
    if (transcript.trim().length < MIN_TRANSCRIPT_CHARS) {
      setResult({ ok: false, stage: "bad_request" });
      return;
    }

    setLoading(true);
    setResult(null);
    setRunId((n) => n + 1);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcript }),
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
      setLoading(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    void run();
  }

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6">
      <h1 className="text-xl font-bold">YT Quiz Tool — Phase 0 spike</h1>
      <p className="text-sm text-gray-600">
        Paste a transcript. No YouTube fetching, no DB, no auth.
      </p>

      <form onSubmit={onSubmit} className="space-y-2">
        <textarea
          className="w-full h-64 border p-2 font-mono text-sm"
          placeholder="Paste raw transcript here…"
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
        />
        {/* Only disabled while in flight. A too-short transcript is allowed through
            so the user gets an explanation instead of a dead button. */}
        <button
          type="submit"
          className="border px-3 py-1 disabled:opacity-50"
          disabled={loading}
        >
          {loading ? LOADING_PHASES[phase] : "Generate quiz"}
        </button>
      </form>

      {/* aria-live so the wait, and the phase change, are announced not just shown. */}
      {loading && (
        <div role="status" aria-live="polite" className="border p-3 text-sm">
          {LOADING_PHASES[phase]} this usually takes 20–30 seconds.
        </div>
      )}

      {result && !result.ok && (
        <div className="border border-red-500 p-3 space-y-3">
          <div className="font-bold text-red-700">Couldn&apos;t generate a quiz</div>
          <div className="text-sm">{FAILURE_COPY[result.stage]}</div>
          <button
            type="button"
            className="border px-3 py-1 disabled:opacity-50"
            disabled={loading}
            onClick={() => void run()}
          >
            Try again
          </button>
        </div>
      )}

      {result?.ok && <Result key={runId} result={result} />}
    </main>
  );
}

function Result({ result }: { result: GenerateSuccess }) {
  const { data } = result;
  const [bannerDismissed, setBannerDismissed] = useState(false);

  // The gate is deliberately soft: low confidence never rejects, it only caveats.
  const lowConfidence = data.confidence < CONFIDENCE_THRESHOLD;
  // Confidently non-educational is the only rejection.
  const rejected = !data.is_educational && !lowConfidence;

  return (
    <div className="space-y-4">
      {/* `!data.quiz` also lands here: with nothing to render, this is the only sane fallback. */}
      {rejected || !data.quiz ? (
        <div className="border p-3 space-y-1">
          <div className="font-bold">
            {rejected ? "Out of scope" : "No quiz generated"}
          </div>
          {rejected ? (
            <>
              <div className="text-sm">
                This doesn&apos;t appear to be educational content.
              </div>
              <div className="text-sm text-gray-600">{data.reason}</div>
            </>
          ) : (
            <div className="text-sm">
              Couldn&apos;t generate a quiz for this content — try another video.
            </div>
          )}
        </div>
      ) : (
        <>
          {lowConfidence && !bannerDismissed && (
            <div className="border border-yellow-600 bg-yellow-50 p-3 text-sm flex gap-3">
              <span className="grow">
                This content is loosely structured — quiz quality may be uneven.
              </span>
              <button
                type="button"
                aria-label="Dismiss"
                className="shrink-0"
                onClick={() => setBannerDismissed(true)}
              >
                ✕
              </button>
            </div>
          )}
          <QuizView quiz={data.quiz} />
        </>
      )}
    </div>
  );
}

function QuizView({ quiz }: { quiz: Quiz }) {
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [checked, setChecked] = useState(false);

  const score = quiz.questions.reduce(
    (n, q, i) => n + (answers[i] === q.correct_index ? 1 : 0),
    0,
  );

  return (
    <div className="space-y-6">
      {quiz.questions.map((q, i) => (
        <div key={i} className="border p-3 space-y-2">
          <div className="font-medium">
            {i + 1}. {q.question}
          </div>
          <div className="space-y-1">
            {q.options.map((opt, j) => (
              <label key={j} className="block text-sm">
                <input
                  type="radio"
                  name={`q${i}`}
                  checked={answers[i] === j}
                  disabled={checked}
                  onChange={() => setAnswers((a) => ({ ...a, [i]: j }))}
                />{" "}
                {opt}
                {checked && j === q.correct_index && " ✅"}
                {checked && answers[i] === j && j !== q.correct_index && " ❌"}
              </label>
            ))}
          </div>
          {checked && (
            <div className="text-sm bg-gray-100 p-2">
              <strong>Explanation:</strong> {q.explanation}
            </div>
          )}
        </div>
      ))}

      {!checked ? (
        <button className="border px-3 py-1" onClick={() => setChecked(true)}>
          Check answers
        </button>
      ) : (
        <div className="space-y-4">
          <div className="font-bold">
            Score: {score} / {quiz.questions.length}
          </div>
          <div>
            <div className="font-bold">Go deeper</div>
            <ul className="list-disc pl-6 text-sm">
              {quiz.deeper_topics.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
