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
 * this session (where it fails, it fails every time), else recording for the Worker. Asked only where the browser
 * has one of the two.
 */
export function pickEngine(can: { recognition: boolean; local?: LocalStatus; browserFailed: boolean; record: boolean }): DictationEngine {
  if (can.recognition && !can.browserFailed) return can.local === "available" ? "local" : "browser";
  return can.record ? "server" : "browser";
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
  // Decoding resamples to the context's rate; an offline context opens no audio device.
  const decoded = await new OfflineAudioContext(1, 1, DICTATION_SAMPLE_RATE).decodeAudioData(await clip.arrayBuffer());
  if (decoded.numberOfChannels === 1) return encodeWav(decoded.getChannelData(0));
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c));
  const mono = new Float32Array(decoded.length);
  for (let i = 0; i < mono.length; i++) mono[i] = channels.reduce((sum, channel) => sum + channel[i], 0) / channels.length;
  return encodeWav(mono);
}
