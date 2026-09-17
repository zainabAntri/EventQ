'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { AttendeeSessionResponse } from '@eventq/contracts';
import { joinEvent } from '@/lib/api-client/public-events';

/**
 * One identity per page, shared by everything on it.
 *
 * The form and the board both need the attendee session — the form for its
 * limits and identity mode, the board for whether voting is on and, more
 * fundamentally, for the cookie that lets it read the list at all. If each
 * called `joinEvent` on mount they would race: two requests with no cookie yet,
 * two attendee rows minted, and whichever response landed last would win the
 * cookie while the other identity was orphaned with a question quota nobody
 * will use. So the join happens exactly once, here, and both consumers wait on
 * the same promise.
 *
 * `ensureSession` is the retry path. The background join can fail on venue
 * wifi, and a failure there is deliberately silent — an error about something
 * the attendee never asked for is noise. Whoever needs the session next calls
 * this and gets a fresh attempt; nothing dead-ends on a lost first request.
 */
interface AttendeeSessionContextValue {
  session: AttendeeSessionResponse | null;
  ensureSession: () => Promise<AttendeeSessionResponse>;
  /**
   * Bumped when this device submits a question, so the board reloads and shows
   * it straight away rather than on its next poll. A counter rather than an
   * event bus: consumers put it in a dependency list and React does the rest.
   */
  boardVersion: number;
  notifyQuestionSubmitted: () => void;
}

const AttendeeSessionContext = createContext<AttendeeSessionContextValue | null>(null);

export function AttendeeSessionProvider({
  joinCode,
  children,
}: {
  joinCode: string;
  children: React.ReactNode;
}) {
  const [session, setSession] = useState<AttendeeSessionResponse | null>(null);
  const [boardVersion, setBoardVersion] = useState(0);

  // The in-flight join, so concurrent callers share one request. A ref rather
  // than state: nothing renders differently while it is pending.
  const inFlight = useRef<Promise<AttendeeSessionResponse> | null>(null);
  const sessionRef = useRef<AttendeeSessionResponse | null>(null);

  const ensureSession = useCallback((): Promise<AttendeeSessionResponse> => {
    if (sessionRef.current) return Promise.resolve(sessionRef.current);
    if (inFlight.current) return inFlight.current;

    const attempt = joinEvent(joinCode)
      .then((joined) => {
        sessionRef.current = joined;
        setSession(joined);
        return joined;
      })
      .finally(() => {
        // Cleared on failure too, so the next caller starts a fresh attempt
        // instead of inheriting a rejected promise forever.
        inFlight.current = null;
      });

    inFlight.current = attempt;
    return attempt;
  }, [joinCode]);

  // Minted in the background so it is ready by the time anyone has finished
  // typing. Failure is retried by whoever needs the session next.
  useEffect(() => {
    void ensureSession().catch(() => {
      /* Retried on demand. */
    });
  }, [ensureSession]);

  const notifyQuestionSubmitted = useCallback(() => {
    setBoardVersion((version) => version + 1);
  }, []);

  const value = useMemo(
    () => ({ session, ensureSession, boardVersion, notifyQuestionSubmitted }),
    [session, ensureSession, boardVersion, notifyQuestionSubmitted],
  );

  return (
    <AttendeeSessionContext.Provider value={value}>{children}</AttendeeSessionContext.Provider>
  );
}

export function useAttendeeSession(): AttendeeSessionContextValue {
  const value = useContext(AttendeeSessionContext);
  if (!value) {
    // Only reachable if a component was rendered outside the provider. Failing
    // loudly beats a board that silently never loads.
    throw new Error('useAttendeeSession must be used inside AttendeeSessionProvider.');
  }
  return value;
}
