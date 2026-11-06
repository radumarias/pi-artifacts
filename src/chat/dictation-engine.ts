import { DICTATION_SAMPLE_RATE, encodeWav } from "../../shared/dictation.ts";

/**
 * Which way the composer's microphone turns speech into text, best first:
 * - "local": the browser's speech recognition on this device (Chrome 139+, once its language pack is installed). Works
 *   offline, and the audio stays on the device.
 * - "browser": the browser's speech recognition, which in Chrome sends the audio to Google's service. Chromium browsers
 *   without Google's key (Brave, Arc) and blocked networks fail it at once with a "network" error.
 * - "server": the clip is recorded here and the Worker transcribes it with Whisper on Workers AI (worker/dictation.ts):
 *   every browser that can record, but the text arrives once the recording stops.
 */
export type DictationEngine = "local" | "browser" | "server";

/** What `SpeechRecognition.available({ processLocally: true })` says of on-device recognition for a language. */
export type LocalStatus = "available" | "downloadable" | "downloading" | "unavailable";

/**
 * The engine for the next dictation: on-device recognition when it is ready, else the browser's own until it failed
 * this session (where it fails, it fails every time), else recording for the Worker. Undefined: no way to dictate.
 */
export function pickEngine(can: { recognition: boolean; local?: LocalStatus; browserFailed: boolean; record: boolean }): DictationEngine | undefined {
  if (can.recognition && !can.browserFailed) return can.local === "available" ? "local" : "browser";
  if (can.record) return "server";
  return can.recognition ? "browser" : undefined;
}

/**
 * The browser recognition's errors that say it cannot work here, so the Worker takes over: its service is unreachable
 * or refused, or it has no model for the language. "not-allowed" (the microphone is blocked) is not one: recording
 * needs the microphone too.
 */
export function fallsBackToServer(error: string): boolean {
  return error === "network" || error === "service-not-allowed" || error === "language-not-supported";
}

/** A recorded clip (WebM, Ogg or MP4, whatever the browser records) as the WAV the Worker takes: 16 kHz mono. */
export async function clipToWav(clip: Blob): Promise<Uint8Array<ArrayBuffer>> {
  const context = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(await clip.arrayBuffer());
  } finally {
    void context.close();
  }
  // OfflineAudioContext mixes the channels down to one and resamples.
  const frames = Math.max(1, Math.ceil(decoded.duration * DICTATION_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, frames, DICTATION_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  return encodeWav((await offline.startRendering()).getChannelData(0));
}
