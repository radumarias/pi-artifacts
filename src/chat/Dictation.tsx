import { memo, useEffect, useRef, useState } from "react";
import { Icon } from "../Icon.tsx";

// The DOM typings carry the speech events but not the recognizer itself.
interface Recognizer {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognizerClass = new () => Recognizer;
const speech = window as unknown as { SpeechRecognition?: RecognizerClass; webkitSpeechRecognition?: RecognizerClass };
const Recognition = speech.SpeechRecognition ?? speech.webkitSpeechRecognition;

const ERRORS: Record<string, string> = {
  "not-allowed": "Microphone access is blocked for this site",
  "service-not-allowed": "Dictation is not available in this browser",
  "audio-capture": "No microphone found",
  network: "Dictation needs a network connection",
};

/** Dictates into the message with the browser's speech recognition; hidden where the browser has none. Memoized: the chat re-renders on every streamed token. */
export const Dictation = memo(function Dictation({ disabled, onText }: { disabled: boolean; onText: (text: string) => void }) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string>();
  const recognizer = useRef<Recognizer>(undefined);
  useEffect(() => () => recognizer.current?.abort(), []);
  if (!Recognition) return null;

  const toggle = () => {
    if (recognizer.current) return recognizer.current.stop();
    const next = new Recognition();
    next.continuous = true;
    next.interimResults = false;
    next.lang = navigator.language;
    next.onresult = (event) => {
      // Without interim results, every result is final.
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i][0].transcript.trim();
        if (text) onText(text);
      }
    };
    // "aborted" and "no-speech" just end the session; anything else is shown next to the button.
    next.onerror = (event) => {
      if (event.error !== "aborted" && event.error !== "no-speech") setError(ERRORS[event.error] ?? `Dictation stopped (${event.error})`);
    };
    next.onend = () => {
      recognizer.current = undefined;
      setListening(false);
    };
    recognizer.current = next;
    setError(undefined);
    next.start();
    setListening(true);
  };

  // A toggle keeps one name; aria-pressed says whether it is on.
  return (
    <>
      <button
        type="button"
        className={listening ? "icon-button listening" : "icon-button"}
        onClick={toggle}
        disabled={disabled && !listening}
        title={listening ? "Stop dictation" : "Dictate"}
        aria-label="Dictate"
        aria-pressed={listening}
      >
        <Icon>
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
        </Icon>
      </button>
      {error && (
        <span className="dictation-error" role="status">
          {error}
        </span>
      )}
    </>
  );
});
