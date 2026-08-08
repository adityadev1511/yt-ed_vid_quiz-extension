import { GEMINI_RESPONSE_SCHEMA } from "./schema";

/**
 * Thin LLM gateway: Gemini 2.5 Flash primary, Groq (Llama) fallback.
 *
 * Contract: return the model's raw text and which model produced it. Parsing and
 * validation are the caller's job — the gateway stays dumb about our schema
 * beyond handing Gemini a responseSchema to steer generation.
 */

export class LlmError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
    /** True when the failure was a hung request we gave up on, not a rejection. */
    readonly timedOut = false,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export type LlmResult = {
  text: string;
  model_used: string;
};

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

/**
 * Per-provider ceiling for a single call. Gemini gets ~2x its observed worst
 * case (21.6s over five runs) so ordinary provider variance does not demote a
 * request to the fallback. Groq is materially faster and needs less.
 */
const PROVIDER_TIMEOUT_MS: Record<Provider, number> = {
  gemini: 40_000,
  groq: 25_000,
};

/** Hard ceiling for the whole gateway, across every attempt. */
const TOTAL_BUDGET_MS = 70_000;

/** Below this there is not enough budget left for an attempt to be worth starting. */
const MIN_ATTEMPT_MS = 5_000;

type Provider = "gemini" | "groq";

/**
 * Two Gemini attempts, because most non-timeout failures here are transient
 * 429/503s and a retry is cheap. A timeout is different — see generate().
 */
const ATTEMPTS: Array<{
  label: string;
  provider: Provider;
  call: (prompt: string, timeoutMs: number) => Promise<LlmResult>;
}> = [
  { label: "gemini attempt 1", provider: "gemini", call: callGemini },
  { label: "gemini attempt 2", provider: "gemini", call: callGemini },
  { label: "groq fallback", provider: "groq", call: callGroq },
];

export async function generate(prompt: string): Promise<LlmResult> {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const failures: Array<{ text: string; timedOut: boolean }> = [];
  // A provider that just timed out gets no retry: it is slow, not flaky, so a
  // second attempt would burn the budget the fallback needs.
  const timedOutProviders = new Set<Provider>();

  for (const { label, provider, call } of ATTEMPTS) {
    if (timedOutProviders.has(provider)) {
      failures.push({
        text: `${label}: skipped, ${provider} already timed out`,
        timedOut: false,
      });
      continue;
    }

    const remaining = deadline - Date.now();
    if (remaining < MIN_ATTEMPT_MS) {
      failures.push({
        text: `${label}: skipped, only ${remaining}ms of budget left`,
        timedOut: true,
      });
      continue;
    }

    // Never let one attempt run past the overall budget.
    const timeoutMs = Math.min(PROVIDER_TIMEOUT_MS[provider], remaining);
    try {
      return await call(prompt, timeoutMs);
    } catch (err) {
      const timedOut = isTimeout(err);
      if (timedOut) timedOutProviders.add(provider);
      failures.push({ text: `${label}: ${errorText(err)}`, timedOut });
    }
  }

  throw new LlmError(
    "All LLM providers failed.",
    failures.map((f) => f.text).join("\n"),
    // If anything hung, "took too long" is the most actionable thing to tell a user,
    // even when a later provider failed for some other reason.
    failures.some((f) => f.timedOut),
  );
}

function isTimeout(err: unknown): boolean {
  if (err instanceof LlmError) return err.timedOut;
  // AbortSignal.timeout rejects with a DOMException named TimeoutError.
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

async function callGemini(prompt: string, timeoutMs: number): Promise<LlmResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new LlmError("GEMINI_API_KEY is not set.");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: GEMINI_RESPONSE_SCHEMA,
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );

  if (!res.ok) {
    throw new LlmError(`Gemini HTTP ${res.status}`, await res.text());
  }

  const body = await res.json();
  // 2.5 models can emit thinking parts; those carry `thought: true` and are not answer text.
  const parts = body?.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .filter((p: { thought?: boolean }) => !p?.thought)
    .map((p: { text?: string }) => p?.text ?? "")
    .join("")
    .trim();

  if (!text) {
    throw new LlmError(
      "Gemini returned no text.",
      JSON.stringify(body).slice(0, 2000),
    );
  }

  return { text, model_used: GEMINI_MODEL };
}

/**
 * Fallback stub. Groq's OpenAI-compatible endpoint has no response-schema
 * enforcement, only json_object mode — the shape is carried by SCHEMA_CONTRACT in
 * the prompt and caught by Zod if the model wanders. Untested against a live key
 * so far; it exists so the fallback path is real code rather than a TODO.
 */
async function callGroq(prompt: string, timeoutMs: number): Promise<LlmResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new LlmError("GROQ_API_KEY is not set; fallback skipped.");

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    throw new LlmError(`Groq HTTP ${res.status}`, await res.text());
  }

  const body = await res.json();
  const text: string = (body?.choices?.[0]?.message?.content ?? "").trim();

  if (!text) {
    throw new LlmError(
      "Groq returned no text.",
      JSON.stringify(body).slice(0, 2000),
    );
  }

  return { text, model_used: GROQ_MODEL };
}

function errorText(err: unknown): string {
  if (err instanceof LlmError) {
    return err.detail ? `${err.message} :: ${err.detail.slice(0, 500)}` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
