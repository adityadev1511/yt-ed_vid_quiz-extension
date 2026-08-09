import { NextResponse } from "next/server";

import type { FailureStage, GenerateResponse } from "@/lib/api-types";
import { LlmError, generate } from "@/lib/llm";
import { buildPrompt } from "@/lib/prompt";
import { LlmResponseSchema } from "@/lib/schema";

// LLM calls are slow and key-dependent: never prerender or cache this.
export const dynamic = "force-dynamic";
// Just above the gateway's 70s total budget, so our own timeout always wins first
// and the user gets a clean message rather than a platform-level kill.
export const maxDuration = 85;

/**
 * Outer guard: without it an unexpected throw returns Next's HTML error page,
 * which the client cannot parse as JSON — the UI would show a parse failure
 * instead of the real problem. Every exit from here is typed JSON.
 */
export async function POST(req: Request): Promise<NextResponse<GenerateResponse>> {
  try {
    return await handle(req);
  } catch (err) {
    return fail(
      500,
      "server_error",
      "Unexpected server error.",
      // Stack included: this is the one failure with no other diagnostic trail.
      err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err),
    );
  }
}

async function handle(req: Request): Promise<NextResponse<GenerateResponse>> {
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
    result = await generate({
      primary: buildPrompt(transcript),
      fallback: buildPrompt(transcript, { reinforce: true }),
    });
  } catch (err) {
    const timedOut = err instanceof LlmError && err.timedOut;
    return fail(
      timedOut ? 504 : 502,
      timedOut ? "timeout" : "llm_error",
      err instanceof Error ? err.message : "LLM call failed.",
      err instanceof LlmError ? err.detail : String(err),
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

/**
 * The single failure exit. Everything diagnostic goes to the server log (and so
 * to the Zerops runtime log); the client gets only the stage. If you need more
 * context to debug a live issue, add it to the log call here — never to the
 * response body.
 */
function fail(
  status: number,
  stage: FailureStage,
  logMessage: string,
  logDetail?: string,
  rawOutput?: string,
): NextResponse<GenerateResponse> {
  console.error(
    [
      `[api/generate] ${stage} (${status}): ${logMessage}`,
      logDetail && `  detail: ${logDetail}`,
      rawOutput && `  raw model output:\n${rawOutput}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );

  return NextResponse.json({ ok: false, stage }, { status });
}
