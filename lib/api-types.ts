import type { LlmResponse } from "./schema";

/** Shared between the route handler and the page so the UI can exhaustively branch. */
export type GenerateSuccess = {
  ok: true;
  model_used: string;
  data: LlmResponse;
  /** True when this came from the quiz cache rather than a fresh LLM call. */
  cached: boolean;
};

export type GenerateRequest = {
  transcript: string;
  /**
   * Present only when the transcript is exactly what we fetched for that video,
   * so a hand-edited transcript is never cached under the video's id.
   */
  video_id?: string | null;
  /** Regenerate: skip the cache read, and overwrite whatever is stored. */
  force?: boolean;
};

/**
 * Every way this can fail. The UI maps each to human copy, so adding a stage
 * here forces you to add a message there — that is the point of the union.
 */
export type FailureStage =
  | "bad_request" // our input: empty or too-short transcript
  | "network" // client-side only: request never reached the server
  | "timeout" // a provider hung and we stopped waiting
  | "llm_error" // provider rejected or errored
  | "invalid_json" // model output was not parseable JSON
  | "validation_error" // model output parsed but failed Zod
  | "server_error"; // anything unexpected

/**
 * Deliberately carries nothing but the stage. Diagnostic context — provider
 * error bodies, Zod issues, raw model output — is logged server-side only and
 * never crosses the wire, so there is nothing raw for the browser to render.
 * The UI maps `stage` to human copy.
 */
export type GenerateFailure = {
  ok: false;
  stage: FailureStage;
};

export type GenerateResponse = GenerateSuccess | GenerateFailure;
