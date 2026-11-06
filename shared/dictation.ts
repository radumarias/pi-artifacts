/**
 * Dictation the Worker transcribes (POST /api/dictation, worker/dictation.ts): for browsers whose own speech
 * recognition is missing (Firefox) or cannot reach its service (Chromium browsers without Google's key, like Brave or
 * Arc, a blocked network). The composer records the clip, turns it into 16 kHz mono 16-bit WAV (what Whisper hears
 * anyway), and posts it; the Worker reads the length off the WAV header, so a clip's minutes count without decoding it.
 */

export const DICTATION_ROUTE = "/api/dictation";

/** The one audio format the route takes. */
export const DICTATION_TYPE = "audio/wav";

export const DICTATION_SAMPLE_RATE = 16_000;

/** The longest clip: the recording stops by itself then. */
export const DICTATION_MAX_SECONDS = 120;

const HEADER_BYTES = 44;
const BYTES_PER_SECOND = DICTATION_SAMPLE_RATE * 2;

/** The largest body the route reads: the longest clip, with a header that may carry a few extra chunks. */
export const DICTATION_MAX_BYTES = DICTATION_MAX_SECONDS * BYTES_PER_SECOND + 4096;

/** Samples from -1 to 1 as a 16 kHz mono 16-bit PCM WAV file. `samples` must already be at DICTATION_SAMPLE_RATE. */
export function encodeWav(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(HEADER_BYTES + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, DICTATION_SAMPLE_RATE, true);
  view.setUint32(28, BYTES_PER_SECOND, true);
  view.setUint16(32, 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(HEADER_BYTES + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return bytes;
}

/**
 * How many seconds of audio a WAV file holds, when it is the format the route takes (16 kHz mono 16-bit PCM);
 * otherwise why not. Chunks other than "fmt " and "data" are skipped, as WAV readers do.
 */
export function wavSeconds(bytes: Uint8Array): number | string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return "Expected a WAV file.";
  let format = false;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > bytes.length) return "The WAV file's format chunk is cut short.";
      const pcm = view.getUint16(body, true) === 1;
      const mono = view.getUint16(body + 2, true) === 1;
      const rate = view.getUint32(body + 4, true) === DICTATION_SAMPLE_RATE;
      const bits = view.getUint16(body + 14, true) === 16;
      if (!(pcm && mono && rate && bits)) return `Expected ${DICTATION_SAMPLE_RATE / 1000} kHz mono 16-bit PCM audio.`;
      format = true;
    } else if (id === "data") {
      if (!format) return "The WAV file has no format chunk before its data.";
      // A recorder that could not seek back writes 0 or the maximum here: count what is there.
      return Math.min(size, bytes.length - body) / BYTES_PER_SECOND;
    }
    at = body + size + (size % 2);
  }
  return "The WAV file has no audio data.";
}

/** The language Whisper is told the clip is in, from a BCP 47 tag ("en-GB" → "en"); undefined lets it detect it. */
export function dictationLanguage(tag: string | null | undefined): string | undefined {
  const language = tag?.split("-")[0]?.toLowerCase();
  return language && /^[a-z]{2,3}$/.test(language) ? language : undefined;
}
