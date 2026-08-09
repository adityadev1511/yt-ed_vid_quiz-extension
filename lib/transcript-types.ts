import type { TranscriptFailureReason } from "./transcript";

/**
 * Shared between the transcript route and the page.
 *
 * Kept separate from the caption-fetching module so the client bundle never
 * pulls in youtube-transcript just to name a failure reason.
 */

export type TranscriptSuccess = {
  ok: true;
  video_id: string;
  transcript: string;
  lang?: string;
};

/** `invalid_url` is decided before any fetch; the rest come from the fetch itself. */
export type TranscriptFailure = {
  ok: false;
  reason: TranscriptFailureReason | "invalid_url";
};

export type TranscriptResult = TranscriptSuccess | TranscriptFailure;
