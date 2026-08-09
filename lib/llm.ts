import { GEMINI_RESPONSE_SCHEMA, GROQ_JSON_SCHEMA } from "./schema";

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
    /** HTTP status, when the failure came from a provider response. */
    readonly status?: number,
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
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

/** low | medium | high. Only read for gpt-oss models. */
const GROQ_REASONING_EFFORT = process.env.GROQ_REASONING_EFFORT || "medium";

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

/** The primary and fallback variants of the same request; see buildPrompt(). */
export type Prompts = { primary: string; fallback: string };

export async function generate(prompts: Prompts): Promise<LlmResult> {
  // Testing switch: exercise the fallback without waiting for Gemini to fail.
  const forceFallback = process.env.FORCE_FALLBACK === "true";
  const attempts = forceFallback
    ? ATTEMPTS.filter((a) => a.provider === "groq")
    : ATTEMPTS;
  if (forceFallback) console.warn("[llm] FORCE_FALLBACK=true — skipping Gemini.");

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const failures: Array<{ text: string; timedOut: boolean }> = [];
  // Providers whose remaining attempts are pointless, mapped to the reason.
  // A timeout means slow-not-flaky, and a 429 means the quota is gone for longer
  // than our whole budget — retrying either just delays the fallback.
  const noRetry = new Map<Provider, string>();

  for (const { label, provider, call } of attempts) {
    const skipReason = noRetry.get(provider);
    if (skipReason) {
      failures.push({
        text: `${label}: skipped, ${provider} ${skipReason}`,
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
      // Groq gets the reinforced variant; Gemini has responseSchema enforcement
      // and follows the base prompt reliably.
      const prompt = provider === "groq" ? prompts.fallback : prompts.primary;
      const result = await call(prompt, timeoutMs);

      // A request that succeeds on a later attempt still returns HTTP 200, so
      // without this the log shows a healthy app while the weaker model quietly
      // carries every request. This is the only signal that degradation started.
      if (failures.length > 0) {
        console.warn(
          [
            `[llm] DEGRADED: served by ${result.model_used} after ${failures.length} failed attempt(s)`,
            ...failures.map((f) => `  ${f.text}`),
          ].join("\n"),
        );
      }

      return result;
    } catch (err) {
      const timedOut = isTimeout(err);
      if (timedOut) noRetry.set(provider, "already timed out");
      else if (isRateLimited(err)) noRetry.set(provider, "is rate limited (429)");
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

/**
 * Quota/rate-limit rejection. Gemini's free tier answers these in ~200ms with a
 * "retry in ~53s" hint — longer than the whole gateway budget — so a second
 * attempt is guaranteed to fail. Not treated as a timeout: the user-facing
 * failure is llm_error, not "taking too long".
 */
function isRateLimited(err: unknown): boolean {
  return err instanceof LlmError && err.status === 429;
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
    throw new LlmError(`Gemini HTTP ${res.status}`, await res.text(), false, res.status);
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

/** Only the gpt-oss family accepts strict json_schema and reasoning_effort. */
const isGptOss = (model: string) => model.startsWith("openai/gpt-oss");

/**
 * Fallback path. On gpt-oss the response is schema-enforced by Groq itself; on
 * Llama models only json_object mode exists, so the shape rests on the prompt's
 * constraint block and Zod catches anything that wanders.
 */
async function callGroq(prompt: string, timeoutMs: number): Promise<LlmResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new LlmError("GROQ_API_KEY is not set; fallback skipped.");

  const structured = isGptOss(GROQ_MODEL);

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: "user", content: prompt }],
      response_format: structured
        ? {
            type: "json_schema",
            json_schema: {
              name: "quiz_response",
              strict: true,
              schema: GROQ_JSON_SCHEMA,
            },
          }
        : { type: "json_object" },
      // Reasoning costs latency, and this path already runs after a failure.
      // Only gpt-oss accepts the parameter; sending it elsewhere is an error.
      ...(structured ? { reasoning_effort: GROQ_REASONING_EFFORT } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    throw new LlmError(`Groq HTTP ${res.status}`, await res.text(), false, res.status);
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
