import { describe, expect, it } from "vitest";
import { DICTATION_MAX_SECONDS, DICTATION_SAMPLE_RATE, dictationLanguage, encodeWav, wavSeconds } from "../shared/dictation.ts";
import { fallsBackToServer, pickEngine } from "../src/chat/dictation-engine.ts";
import { dictationRoute, type DictationEnv } from "../worker/dictation.ts";

const seconds = (n: number) => encodeWav(new Float32Array(Math.round(n * DICTATION_SAMPLE_RATE)).fill(0.25));

describe("dictation WAV", () => {
  it("writes 16 kHz mono 16-bit PCM and reads its length back", () => {
    const wav = encodeWav(Float32Array.from([0, 1, -1, 2]));
    expect(wav.length).toBe(44 + 8);
    const view = new DataView(wav.buffer);
    expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true), view.getInt16(50, true)]).toEqual([0, 32767, -32768, 32767]);
    expect(wavSeconds(seconds(1.5))).toBe(1.5);
  });

  it("skips other chunks and refuses other formats", () => {
    const wav = seconds(1);
    // A LIST chunk between "fmt " and "data", as some recorders write.
    const list = new Uint8Array([..."LIST"].map((c) => c.charCodeAt(0)).concat([4, 0, 0, 0, 1, 2, 3, 4]));
    const withList = new Uint8Array([...wav.subarray(0, 36), ...list, ...wav.subarray(36)]);
    expect(wavSeconds(withList)).toBe(1);

    const stereo = seconds(1);
    new DataView(stereo.buffer).setUint16(22, 2, true);
    expect(wavSeconds(stereo)).toMatch(/mono/);
    const resampled = seconds(1);
    new DataView(resampled.buffer).setUint32(24, 44_100, true);
    expect(wavSeconds(resampled)).toMatch(/16 kHz/);
    expect(wavSeconds(new TextEncoder().encode("not audio at all"))).toMatch(/WAV/);
    expect(wavSeconds(wav.subarray(0, 36))).toMatch(/no audio/);
  });

  it("counts only the data that is there when the header claims more", () => {
    const wav = seconds(1);
    new DataView(wav.buffer).setUint32(40, 0xffffffff, true);
    expect(wavSeconds(wav)).toBe(1);
  });

  it("tells Whisper the language, or nothing", () => {
    expect(dictationLanguage("en-GB")).toBe("en");
    expect(dictationLanguage("RO")).toBe("ro");
    expect(dictationLanguage("")).toBeUndefined();
    expect(dictationLanguage("x-klingon")).toBeUndefined();
    expect(dictationLanguage(null)).toBeUndefined();
  });
});

describe("dictation engine", () => {
  it("runs on the device when it can, then the browser's service, then the Worker", () => {
    expect(pickEngine({ recognition: true, local: "available", browserFailed: false, record: true })).toBe("local");
    expect(pickEngine({ recognition: true, local: "downloadable", browserFailed: false, record: true })).toBe("browser");
    expect(pickEngine({ recognition: true, browserFailed: false, record: true })).toBe("browser");
    expect(pickEngine({ recognition: true, local: "available", browserFailed: true, record: true })).toBe("server");
    expect(pickEngine({ recognition: false, browserFailed: false, record: true })).toBe("server");
    expect(pickEngine({ recognition: true, browserFailed: true, record: false })).toBe("browser");
  });

  it("hands over to the Worker only when the browser's recognition cannot work here", () => {
    expect(["network", "service-not-allowed", "language-not-supported"].every(fallsBackToServer)).toBe(true);
    expect(["not-allowed", "audio-capture", "no-speech", "aborted"].some(fallsBackToServer)).toBe(false);
  });
});

describe("dictation route", () => {
  function setup(overrides: Partial<DictationEnv> = {}, spent = 0) {
    const runs: { model: string; input: Record<string, unknown> }[] = [];
    const recorded: number[] = [];
    const env: DictationEnv = {
      AI: {
        run: async (model: string, input: Record<string, unknown>) => {
          runs.push({ model, input });
          return { text: "  hello there " };
        },
      },
      DICTATION_MODEL: "@cf/openai/whisper-large-v3-turbo",
      DICTATION_DAILY_MINUTES: "60",
      DICTATION: { limit: async () => ({ success: true }) },
      ...overrides,
    };
    const ledger = { dictationSecondsToday: () => spent, recordDictation: (s: number) => void recorded.push(s) };
    const post = (body: Uint8Array<ArrayBuffer>, type = "audio/wav", lang = "en-US") =>
      dictationRoute(
        new Request(`https://app.test/api/dictation?lang=${lang}`, { method: "POST", headers: { "content-type": type }, body }),
        env,
        "u1",
        ledger,
      );
    return { runs, recorded, post };
  }

  it("writes out a clip with Whisper, in the browser's language, and counts its length", async () => {
    const { runs, recorded, post } = setup();
    const response = await post(seconds(2));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "hello there" });
    expect(runs[0].model).toBe("@cf/openai/whisper-large-v3-turbo");
    expect(runs[0].input).toMatchObject({ language: "en", vad_filter: true });
    expect(typeof runs[0].input.audio).toBe("string");
    expect(recorded).toEqual([2]);
  });

  it("refuses what it should not transcribe, before asking the model", async () => {
    expect((await setup({ DICTATION_MODEL: "" }).post(seconds(1))).status).toBe(503);
    expect((await setup().post(seconds(1), "text/plain")).status).toBe(415);
    expect((await setup().post(new TextEncoder().encode("RIFF....WAVEjunk"))).status).toBe(400);
    expect((await setup().post(seconds(DICTATION_MAX_SECONDS + 5))).status).toBe(413);
    expect((await setup({ DICTATION: { limit: async () => ({ success: false }) } }).post(seconds(1))).status).toBe(429);
    const spentAll = setup({}, 3600);
    const refused = await spentAll.post(seconds(1));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: expect.stringMatching(/today/) });
    expect(spentAll.runs).toHaveLength(0);
  });

  it("reports a failed model call and does not count it", async () => {
    const { recorded, post } = setup({
      AI: {
        run: async () => {
          throw new Error("3010: Invalid input");
        },
      },
    });
    const response = await post(seconds(1));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Dictation failed: 3010: Invalid input" });
    expect(recorded).toEqual([]);
  });
});
