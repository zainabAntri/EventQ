'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Announces changes to screen readers without moving focus.
 *
 * Built for the live question feed: when a moderator approves a question, a
 * sighted user sees it appear, and a screen-reader user gets told. Without this
 * the feed updates silently and they simply never know.
 *
 * `polite` is deliberate — an event feed that interrupts whatever the user is
 * reading, every time anyone in the room asks something, is unusable.
 *
 * The region must be present in the DOM from first render and only its text
 * content may change afterwards; inserting a populated live region is widely
 * ignored by assistive technology.
 */
export function LiveRegion({
  message,
  politeness = 'polite',
}: {
  message: string;
  politeness?: 'polite' | 'assertive';
}) {
  // Alternating between two nodes forces an announcement even when the same
  // message repeats ("1 new question" twice in a row would otherwise be silent
  // the second time, because the text did not change).
  const [slot, setSlot] = useState<0 | 1>(0);
  const previous = useRef(message);

  useEffect(() => {
    if (message !== previous.current) {
      previous.current = message;
      setSlot((current) => (current === 0 ? 1 : 0));
    }
  }, [message]);

  return (
    <div className="sr-only">
      <div aria-live={politeness} aria-atomic="true">
        {slot === 0 ? message : ''}
      </div>
      <div aria-live={politeness} aria-atomic="true">
        {slot === 1 ? message : ''}
      </div>
    </div>
  );
}

/** Visually hidden but present for assistive technology. */
export function VisuallyHidden({ children }: { children: React.ReactNode }) {
  return <span className="sr-only">{children}</span>;
}
