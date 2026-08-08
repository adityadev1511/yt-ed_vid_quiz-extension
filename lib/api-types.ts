import type { LlmResponse } from "./schema";

/** Shared between the route handler and the page so the UI can exhaustively branch. */
export type GenerateSuccess = {
  ok: true;
  model_used: string;
  data: LlmResponse;
};

export type GenerateFailure = {
  ok: false;
  /** bad_request: our input. llm_error: provider failed. invalid_json / validation_error: model output. */
  stage: "bad_request" | "llm_error" | "invalid_json" | "validation_error";
  message: string;
  /** Provider error body, Zod issues, or the raw model text — whatever helps debugging. */
  detail?: string;
  /** Present on validation_error: the raw text the model returned. */
  raw?: string;
};

export type GenerateResponse = GenerateSuccess | GenerateFailure;
