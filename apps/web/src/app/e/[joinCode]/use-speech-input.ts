'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Speech-to-text for the question box, using the browser's own recognizer.
 *
 * Many attendees are not confident typists, and a phone keyboard in a dim room
 * is the slowest part of asking. The Web Speech API costs nothing, needs no
 * server change and no AI, and the text it produces goes through exactly the
 * same validation as typed text.
 *
 * It is progressive enhancement: `supported` is false until mount and stays
 * false in browsers without the API (Firefox), and the form then simply has
 * no mic button. Detection waits for mount so the server HTML and the first
 * client render match.
 *
 * Where the audio goes depends on the browser. Chrome sends it to Google to
 * transcribe; Safari does it on the device. The form says so next to the
 * button, because EventQ promises anonymous questions.
 */

/** The part of the API used here. TypeScript's DOM library does not ship it. */
interface RecognitionAlternative {
  transcript: string;
}
interface RecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: RecognitionAlternative;
}
interface RecognitionResultEvent {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: RecognitionResult };
}
interface RecognitionErrorEvent {
  readonly error: string;
}
export interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionConstructor = new () => SpeechRecognitionLike;

function findRecognition(): RecognitionConstructor | undefined {
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

/** Written for the attendee, not the developer: what happened and what to do. */
function messageForError(code: string): string | null {
  switch (code) {
    case 'aborted':
      // We stopped it ourselves; nothing to report.
      return null;
    case 'not-allowed':
    case 'service-not-allowed':
      return 'The microphone is blocked. Allow it in your browser settings, or type your question instead.';
    case 'no-speech':
      return 'We did not hear anything. Tap the button and try again.';
    case 'audio-capture':
      return 'No microphone was found on this device.';
    case 'network':
      return 'Speech needs an internet connection. Please type your question instead.';
    default:
      return 'Speech input did not work. Please type your question instead.';
  }
}

export function useSpeechInput({ onFinalText }: { onFinalText: (text: string) => void }) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  // The latest callback, so a recognizer that is already running never calls a
  // stale one (it would append to an old copy of the text).
  const onFinalTextRef = useRef(onFinalText);
  useEffect(() => {
    onFinalTextRef.current = onFinalText;
  }, [onFinalText]);

  useEffect(() => {
    // Only known after mount; see the note at the top of this file.
    setSupported(findRecognition() !== undefined);
    return () => recognitionRef.current?.abort();
  }, []);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Recognition = findRecognition();
    if (!Recognition || recognitionRef.current) return;

    const recognition = new Recognition();
    // The phone's own language: the attendee is most likely to speak it.
    recognition.lang = navigator.language;
    recognition.interimResults = true;
    // One phrase per tap. Continuous mode is unreliable on Android Chrome.
    recognition.continuous = false;

    recognition.onresult = (event) => {
      let finalText = '';
      let pending = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result) continue;
        const words = result[0]?.transcript ?? '';
        if (result.isFinal) finalText += words;
        else pending += words;
      }
      setInterim(pending);
      if (finalText.trim()) onFinalTextRef.current(finalText.trim());
    };
    // Resets the button. Guarded, so a late event from an old recognizer cannot
    // reset a new one the attendee has just started.
    const finish = () => {
      if (recognitionRef.current !== recognition) return;
      recognitionRef.current = null;
      setListening(false);
      setInterim('');
    };
    recognition.onerror = (event) => {
      setError(messageForError(event.error));
      // Some browsers (seen on Android Chrome with the microphone blocked)
      // never send `end` after an error, which left the button stuck on
      // "Stop listening". An error always ends the attempt, so finish here.
      recognition.abort();
      finish();
    };
    recognition.onend = finish;

    recognitionRef.current = recognition;
    setError(null);
    setInterim('');
    setListening(true);
    try {
      recognition.start();
    } catch {
      // start() throws if the browser refuses outright.
      recognitionRef.current = null;
      setListening(false);
      setError(messageForError('unknown'));
    }
  }, []);

  return { supported, listening, interim, error, start, stop };
}
