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

/** One retry, because most Gemini failures in practice are transient 429/503s. */
const MAX_ATTEMPTS = 2;

export async function generate(prompt: string): Promise<LlmResult> {
  const errors: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await callGemini(prompt);
    } catch (err) {
      errors.push(`gemini attempt ${attempt}: ${errorText(err)}`);
    }
  }

  try {
    return await callGroq(prompt);
  } catch (err) {
    errors.push(`groq fallback: ${errorText(err)}`);
  }

  throw new LlmError("All LLM providers failed.", errors.join("\n"));
}

async function callGemini(prompt: string): Promise<LlmResult> {
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
async function callGroq(prompt: string): Promise<LlmResult> {
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
