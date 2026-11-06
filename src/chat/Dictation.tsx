import { memo, useEffect, useRef, useState } from "react";
import { DICTATION_MAX_SECONDS } from "../../shared/dictation.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";
import { Icon } from "../Icon.tsx";
import { clipToWav, fallsBackToServer, pickEngine, type LocalStatus } from "./dictation-engine.ts";

// The DOM typings carry the speech events but not the recognizer itself, nor its on-device options (Chrome 139+).
interface Recognizer {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  processLocally?: boolean;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface LocalOptions {
  langs: string[];
  processLocally: true;
}
type RecognizerClass = (new () => Recognizer) & {
  available?: (options: LocalOptions) => Promise<LocalStatus>;
  install?: (options: LocalOptions) => Promise<boolean>;
};
const speech = window as unknown as { SpeechRecognition?: RecognizerClass; webkitSpeechRecognition?: RecognizerClass };
const Recognition = speech.SpeechRecognition ?? speech.webkitSpeechRecognition;
const canRecord = typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

/** Whether the browser's recognition failed in a way it will again (no service, no model): the Worker transcribes from then on, until a reload. */
let browserFailed = false;

const ERRORS: Record<string, string> = {
  "not-allowed": "Microphone access is blocked for this site",
  "service-not-allowed": "Dictation is not available in this browser",
  "audio-capture": "No microphone found",
  network: "Dictation needs a network connection",
};

/** getUserMedia's failures, named as the recognizer's. */
const micError = (error: unknown) =>
  error instanceof DOMException && error.name === "NotAllowedError"
    ? ERRORS["not-allowed"]
    : error instanceof DOMException && error.name === "NotFoundError"
      ? ERRORS["audio-capture"]
      : `Could not start the microphone (${errorMessage(error)})`;

/**
 * On-device recognition's state for `lang`; undefined where the browser cannot say. A language pack that can be
 * downloaded starts downloading, so a later dictation runs on the device.
 */
async function localStatus(lang: string): Promise<LocalStatus | undefined> {
  if (!Recognition?.available) return undefined;
  const options: LocalOptions = { langs: [lang], processLocally: true };
  try {
    const status = await Recognition.available(options);
    if (status === "downloadable") Recognition.install?.(options).catch(() => {});
    return status;
  } catch {
    return undefined;
  }
}

/** One dictation under way: `stop` keeps what was said, `abort` drops it. */
interface Session {
  stop(): void;
  abort(): void;
}

type Phase = "idle" | "starting" | "listening" | "transcribing";

/**
 * Dictates into the message (dictation-engine.ts picks how): the browser's speech recognition, on the device where it
 * can, else a recorded clip the Worker writes out. Hidden where the browser can do neither. Memoized: the chat
 * re-renders on every streamed token.
 */
export const Dictation = memo(function Dictation({ disabled, onText }: { disabled: boolean; onText: (text: string) => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string>();
  const session = useRef<Session>(undefined);
  useEffect(
    () => () => {
      session.current?.abort();
      session.current = undefined;
    },
    [],
  );
  if (!Recognition && !canRecord) return null;

  const lang = navigator.language;
  /** Ends `handle`'s phase, unless another session took over. */
  const finish = (handle: Session) => {
    if (session.current !== handle) return;
    session.current = undefined;
    setPhase("idle");
  };

  const startBrowser = (local: boolean) => {
    const next = new Recognition!();
    next.continuous = true;
    next.interimResults = false;
    next.lang = lang;
    if (local) next.processLocally = true;
    const handle: Session = { stop: () => next.stop(), abort: () => next.abort() };
    next.onresult = (event) => {
      // Without interim results, every result is final.
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i][0].transcript.trim();
        if (text) onText(text);
      }
    };
    next.onerror = (event) => {
      if (session.current !== handle) return;
      // No service or no model here: record for the Worker instead, now and for the rest of the visit.
      if (fallsBackToServer(event.error) && canRecord) {
        browserFailed = true;
        next.abort();
        void startServer();
        return;
      }
      // "aborted" and "no-speech" just end the session; anything else is shown next to the button.
      if (event.error !== "aborted" && event.error !== "no-speech") setError(ERRORS[event.error] ?? `Dictation stopped (${event.error})`);
    };
    next.onend = () => finish(handle);
    session.current = handle;
    next.start();
    setPhase("listening");
  };

  const startServer = async () => {
    const controller = new AbortController();
    let recorder: MediaRecorder | undefined;
    let stream: MediaStream | undefined;
    const release = () => stream?.getTracks().forEach((track) => track.stop());
    const handle: Session = {
      stop: () => recorder?.state === "recording" && recorder.stop(),
      abort: () => {
        controller.abort();
        if (recorder?.state === "recording") recorder.stop();
        release();
      },
    };
    session.current = handle;
    setPhase("starting");
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (failed) {
      if (session.current === handle) setError(micError(failed));
      return finish(handle);
    }
    if (controller.signal.aborted) return release();

    const chunks: Blob[] = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    // The Worker takes clips up to DICTATION_MAX_SECONDS: stop there and write out what was said.
    const timer = setTimeout(handle.stop, DICTATION_MAX_SECONDS * 1000);
    recorder.onstop = async () => {
      clearTimeout(timer);
      release();
      if (controller.signal.aborted) return;
      setPhase("transcribing");
      try {
        const wav = await clipToWav(new Blob(chunks, { type: recorder!.mimeType }));
        const { text } = await api.dictate(wav, lang, controller.signal);
        if (text && !controller.signal.aborted) onText(text);
      } catch (failed) {
        if (!controller.signal.aborted) setError(errorMessage(failed));
      } finally {
        finish(handle);
      }
    };
    recorder.start();
    setPhase("listening");
  };

  const toggle = async () => {
    if (phase === "listening") return session.current?.stop();
    if (phase !== "idle") return;
    setError(undefined);
    setPhase("starting");
    const local = !browserFailed && Recognition ? await localStatus(lang) : undefined;
    const engine = pickEngine({ recognition: !!Recognition, local, browserFailed, record: canRecord });
    if (engine === "server") void startServer();
    else if (engine) startBrowser(engine === "local");
    else setPhase("idle");
  };

  const listening = phase === "listening";
  // A toggle keeps one name; aria-pressed says whether it is on.
  return (
    <>
      <button
        type="button"
        className={listening ? "icon-button listening" : "icon-button"}
        onClick={() => void toggle()}
        disabled={(disabled && !listening) || phase === "starting" || phase === "transcribing"}
        title={listening ? "Stop dictation" : "Dictate"}
        aria-label="Dictate"
        aria-pressed={listening}
      >
        <Icon>
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
        </Icon>
      </button>
      {phase === "transcribing" ? (
        <span className="dictation-status" role="status">
          <span className="spinner" aria-hidden="true" /> Writing out what you said…
        </span>
      ) : (
        error && (
          <span className="dictation-error" role="status">
            {error}
          </span>
        )
      )}
    </>
  );
});
