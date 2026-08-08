import { NextResponse } from "next/server";

import type { GenerateResponse } from "@/lib/api-types";
import { LlmError, generate } from "@/lib/llm";
import { buildPrompt } from "@/lib/prompt";
import { LlmResponseSchema } from "@/lib/schema";

// LLM calls are slow and key-dependent: never prerender or cache this.
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request): Promise<NextResponse<GenerateResponse>> {
  let transcript: unknown;
  try {
    transcript = (await req.json())?.transcript;
  } catch {
    return fail(400, "bad_request", "Body was not valid JSON.");
  }

  if (typeof transcript !== "string" || transcript.trim().length < 50) {
    return fail(
      400,
      "bad_request",
      "Paste a transcript of at least 50 characters.",
    );
  }

  let result;
  try {
    result = await generate(buildPrompt(transcript));
  } catch (err) {
    const detail = err instanceof LlmError ? err.detail : String(err);
    return fail(
      502,
      "llm_error",
      err instanceof Error ? err.message : "LLM call failed.",
      detail,
    );
  }

  // Gemini's responseMimeType should give us clean JSON; Groq's json_object mode
  // occasionally wraps it in a fence. Strip that one known case, then fail loudly.
  const cleaned = stripFence(result.text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return fail(
      502,
      "invalid_json",
      `${result.model_used} did not return parseable JSON.`,
      err instanceof Error ? err.message : String(err),
      result.text,
    );
  }

  const validated = LlmResponseSchema.safeParse(parsed);
  if (!validated.success) {
    return fail(
      502,
      "validation_error",
      `${result.model_used} output did not match the schema.`,
      JSON.stringify(validated.error.issues, null, 2),
      result.text,
    );
  }

  return NextResponse.json({
    ok: true,
    model_used: result.model_used,
    data: validated.data,
  });
}

function stripFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1] : text;
}

function fail(
  status: number,
  stage: Extract<GenerateResponse, { ok: false }>["stage"],
  message: string,
  detail?: string,
  raw?: string,
): NextResponse<GenerateResponse> {
  return NextResponse.json({ ok: false, stage, message, detail, raw }, { status });
}
