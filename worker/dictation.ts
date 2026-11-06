import { DICTATION_MAX_BYTES, DICTATION_MAX_SECONDS, DICTATION_TYPE, dictationLanguage, wavSeconds } from "../shared/dictation.ts";
import { errorMessage, isObject, toBase64 } from "../shared/util.ts";
import { json } from "./http.ts";
import type { ModelRunner } from "./agent/workers-ai.ts";

/**
 * POST /api/dictation?lang=<BCP 47>: a recorded clip (16 kHz mono WAV, shared/dictation.ts) in, its text out, from a
 * speech-to-text model on Workers AI (DICTATION_MODEL, Whisper by default) through the AI binding. The composer sends
 * it only when the browser's own speech recognition is missing or failed. Each person may dictate DICTATION_DAILY_MINUTES
 * a day (UTC), counted in their UserDirectory from the clips' lengths, and send DICTATION clips a minute.
 *
 * The body's content type must be audio/wav: a form or a no-CORS fetch from another site cannot send that without a
 * preflight, and the Worker refuses another site's Origin anyway.
 */

/** Where the minutes a person dictated today are kept: their UserDirectory. */
export interface DictationLedger {
  dictationSecondsToday(): number | Promise<number>;
  recordDictation(seconds: number): void | Promise<void>;
}

export interface DictationEnv {
  AI: ModelRunner;
  DICTATION_MODEL: string;
  DICTATION_DAILY_MINUTES: string;
  DICTATION: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

export async function dictationRoute(request: Request, env: DictationEnv, uid: string, ledger: DictationLedger): Promise<Response> {
  const model = env.DICTATION_MODEL.trim();
  if (!model) return json({ error: "Dictation is not set up on this server." }, 503);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== DICTATION_TYPE)
    return json({ error: `Expected ${DICTATION_TYPE}.` }, 415);
  if (Number(request.headers.get("content-length") ?? 0) > DICTATION_MAX_BYTES) return tooLong();

  const [{ success }, spent] = await Promise.all([env.DICTATION.limit({ key: uid }), ledger.dictationSecondsToday()]);
  if (!success) return json({ error: "Too many dictations; wait a minute." }, 429);
  // Checked before and counted after, like pages' model calls: clips at the same moment can each pass.
  if (spent >= (Number(env.DICTATION_DAILY_MINUTES) || 0) * 60) {
    return json({ error: "You used today's dictation minutes; they renew at midnight UTC." }, 429);
  }

  // The length the WAV header claims is never trusted past the bytes that came: the byte cap caps the minutes too.
  const audio = new Uint8Array(await request.arrayBuffer());
  if (audio.byteLength > DICTATION_MAX_BYTES) return tooLong();
  const seconds = wavSeconds(audio);
  if (typeof seconds === "string") return json({ error: seconds }, 400);
  if (seconds < 0.1) return json({ text: "" });

  const language = dictationLanguage(new URL(request.url).searchParams.get("lang"));
  try {
    const text = await transcribe(env.AI, model, audio, language);
    await ledger.recordDictation(seconds);
    return json({ text });
  } catch (error) {
    console.error("dictation failed", error);
    return json({ error: `Dictation failed: ${errorMessage(error)}` }, 502);
  }
}

/** The text a speech-to-text model on Workers AI heard in a WAV clip. Silence (cut by its voice filter) is "". */
async function transcribe(ai: ModelRunner, model: string, wav: Uint8Array, language?: string): Promise<string> {
  const answer = await ai.run(model, { audio: toBase64(wav), vad_filter: true, ...(language && { language }) });
  if (!isObject(answer) || typeof answer.text !== "string") throw new Error("the model answered with no text");
  return answer.text.trim();
}

const tooLong = () => json({ error: `A clip may be at most ${DICTATION_MAX_SECONDS / 60} minutes long.` }, 413);
