import { NextResponse } from "next/server";

import { TranscriptError, fetchTranscript } from "@/lib/transcript";
import type { TranscriptFailure, TranscriptResult } from "@/lib/transcript-types";
import { extractVideoId } from "@/lib/youtube";

// Hits YouTube on every call: never prerender or cache this.
export const dynamic = "force-dynamic";
// Comfortably above the 10s fetch timeout in lib/transcript.ts, so our own
// timeout always wins and the user gets the paste fallback, not a platform kill.
export const maxDuration = 20;

/**
 * Caption fetching is deliberately a separate route from /api/generate:
 * - a caption fetch that fails must land the user in the paste flow, which means
 *   the client needs the outcome before generation is attempted;
 * - on success the fetched text goes into the textarea, so the user can see and
 *   edit exactly what the quiz was built from;
 * - and the LLM route's 70s budget stays reserved for the LLM.
 */
export async function POST(req: Request): Promise<NextResponse<TranscriptResult>> {
  try {
    return await handle(req);
  } catch (err) {
    return fail(
      500,
      "unknown",
      "Unexpected server error.",
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
  }
}

async function handle(req: Request): Promise<NextResponse<TranscriptResult>> {
  let url: unknown;
  try {
    url = (await req.json())?.url;
  } catch {
    return fail(400, "invalid_url", "Body was not valid JSON.");
  }

  if (typeof url !== "string" || !url.trim()) {
    return fail(400, "invalid_url", "No URL supplied.");
  }

  const videoId = extractVideoId(url);
  if (!videoId) {
    return fail(400, "invalid_url", `Could not extract a video ID from: ${url}`);
  }

  try {
    const { text, lang } = await fetchTranscript(videoId);
    console.log(
      `[api/transcript] ok: ${videoId} (${text.length} chars${lang ? `, ${lang}` : ""})`,
    );
    return NextResponse.json({ ok: true, video_id: videoId, transcript: text, lang });
  } catch (err) {
    if (err instanceof TranscriptError) {
      // 200, not an error status: a missing caption track is an expected outcome
      // of a best-effort feature, and the client handles it as a normal branch.
      return fail(200, err.reason, `${videoId}: caption fetch failed`, err.detail);
    }
    throw err;
  }
}

/**
 * The single failure exit. The reason is the only thing that crosses the wire;
 * everything diagnostic goes to the server log, and so to the Zerops runtime log.
 */
function fail(
  status: number,
  reason: TranscriptFailure["reason"],
  logMessage: string,
  logDetail?: string,
): NextResponse<TranscriptResult> {
  console.error(
    [`[api/transcript] ${reason} (${status}): ${logMessage}`, logDetail && `  detail: ${logDetail}`]
      .filter(Boolean)
      .join("\n"),
  );

  return NextResponse.json({ ok: false, reason }, { status });
}
