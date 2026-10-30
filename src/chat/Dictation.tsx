import { useEffect, useRef, useState } from "react";

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

/** Dictates into the message with the browser's speech recognition; hidden where the browser has none. */
export function Dictation({ disabled, onText }: { disabled: boolean; onText: (text: string) => void }) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string>();
  const recognizer = useRef<Recognizer>(undefined);
  // The latest callback, so a recognizer started earlier still writes into the current draft.
  const write = useRef(onText);
  write.current = onText;
  useEffect(() => () => recognizer.current?.abort(), []);
  if (!Recognition) return null;

  const toggle = () => {
    if (recognizer.current) return recognizer.current.stop();
    const next = new Recognition();
    next.continuous = true;
    next.interimResults = false;
    next.lang = navigator.language;
    next.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i].isFinal ? event.results[i][0].transcript.trim() : "";
        if (text) write.current(text);
      }
    };
    next.onerror = (event) => setError(ERRORS[event.error]);
    next.onend = () => {
      recognizer.current = undefined;
      setListening(false);
    };
    recognizer.current = next;
    setError(undefined);
    next.start();
    setListening(true);
  };

  const label = error ?? (listening ? "Stop dictation" : "Dictate");
  return (
    <button type="button" className={listening ? "icon-button listening" : "icon-button"} onClick={toggle} disabled={disabled && !listening} title={label} aria-label={label} aria-pressed={listening}>
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
      </svg>
    </button>
  );
}
