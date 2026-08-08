"use client";

import { useState } from "react";

import type { GenerateResponse, GenerateSuccess } from "@/lib/api-types";
import { CONFIDENCE_THRESHOLD, type Quiz } from "@/lib/schema";

export default function Page() {
  const [transcript, setTranscript] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<GenerateResponse | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcript }),
      });
      setResult((await res.json()) as GenerateResponse);
    } catch (err) {
      setResult({
        ok: false,
        stage: "llm_error",
        message: "Request failed.",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
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
        <button
          type="submit"
          className="border px-3 py-1 disabled:opacity-50"
          disabled={loading || transcript.trim().length < 50}
        >
          {loading ? "Generating…" : "Generate quiz"}
        </button>
      </form>

      {result && !result.ok && (
        <div className="border border-red-500 p-3 space-y-2">
          <div className="font-bold text-red-700">
            Failed at: {result.stage}
          </div>
          <div className="text-sm">{result.message}</div>
          {result.detail && (
            <pre className="overflow-auto text-xs bg-gray-100 p-2 whitespace-pre-wrap">
              {result.detail}
            </pre>
          )}
          {result.raw && (
            <details>
              <summary className="text-xs cursor-pointer">Raw model output</summary>
              <pre className="overflow-auto text-xs bg-gray-100 p-2 whitespace-pre-wrap">
                {result.raw}
              </pre>
            </details>
          )}
        </div>
      )}

      {result?.ok && <Result result={result} />}
    </main>
  );
}

function Result({ result }: { result: GenerateSuccess }) {
  const { data, model_used } = result;

  return (
    <div className="space-y-4">
      {/* Collapsed by default: useful while iterating on the prompt, noise for a quiz taker. */}
      <details className="text-xs text-gray-600">
        <summary className="cursor-pointer">debug</summary>
        <div className="pt-1">
          model: {model_used} · educational: {String(data.is_educational)} ·
          confidence: {data.confidence}
        </div>
        <div>topics: {data.detected_topics.join(", ")}</div>
        {data.quiz && (
          <ul className="pt-1">
            {data.quiz.questions.map((q, i) => (
              <li key={i}>
                {i + 1}. {q.difficulty} · {q.concept_tag}
              </li>
            ))}
          </ul>
        )}
      </details>

      {!data.quiz ? (
        <div className="border p-3 space-y-1">
          <div className="font-bold">Out of scope</div>
          <div className="text-sm">{data.reason}</div>
        </div>
      ) : (
        <>
          {(!data.is_educational || data.confidence < CONFIDENCE_THRESHOLD) && (
            <div className="border border-yellow-600 bg-yellow-50 p-3 text-sm">
              <strong>Loosely structured content.</strong> {data.reason}
            </div>
          )}
          {/* Remount the quiz when a new one arrives so answers/score reset. */}
          <QuizView key={JSON.stringify(data.quiz.questions[0])} quiz={data.quiz} />
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
