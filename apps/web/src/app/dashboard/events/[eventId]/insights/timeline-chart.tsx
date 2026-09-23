'use client';

import type { EventInsightsResponse } from '@eventq/contracts';

/**
 * Questions submitted over time, as a column chart.
 *
 * One series, so one colour and no legend — the heading names it. Every bar
 * is focusable and carries its own label, so the exact count is reachable by
 * hover, by keyboard and by screen reader, and the same numbers are available
 * as a plain table underneath for anyone who would rather read than look.
 *
 * Built from divs rather than a charting library: it is one bar chart, and a
 * dependency for it would outweigh the page it sits on.
 */
export function TimelineChart({ timeline }: { timeline: EventInsightsResponse['timeline'] }) {
  const { buckets, bucketMinutes } = timeline;
  if (buckets.length === 0) {
    return <p className="mt-2 text-sm text-[var(--muted)]">No questions yet.</p>;
  }

  const peak = Math.max(...buckets.map((bucket) => bucket.count));
  const format = bucketFormatter(bucketMinutes, buckets);
  const last = buckets[buckets.length - 1]!;
  const middle = buckets[Math.floor(buckets.length / 2)]!;

  return (
    <figure className="mt-3">
      <div className="flex items-baseline justify-between text-xs text-[var(--muted)]">
        <span className="tabular-nums">Peak {peak}</span>
        <span>Each bar is {describeMinutes(bucketMinutes)}</span>
      </div>

      <ol
        aria-label="Questions submitted per interval"
        className="mt-1 flex h-40 items-end gap-0.5 border-b border-[var(--border)]"
      >
        {buckets.map((bucket) => {
          const label = `${format(bucket.start)}: ${bucket.count} ${bucket.count === 1 ? 'question' : 'questions'}`;
          return (
            <li
              key={bucket.start}
              tabIndex={0}
              aria-label={label}
              className="group relative flex h-full min-w-0 flex-1 items-end focus-visible:outline-offset-0"
            >
              <div
                className="w-full rounded-t-[4px] bg-brand-500 group-hover:bg-brand-600 group-focus-visible:bg-brand-600 dark:bg-brand-300 dark:group-hover:bg-brand-100"
                // A zero bucket keeps a hairline, so a quiet stretch reads as
                // "nothing happened" rather than as a gap in the data.
                style={{ height: bucket.count === 0 ? '1px' : `${(bucket.count / peak) * 100}%` }}
              />
              <span
                // The bar's own aria-label already says this; the tooltip is
                // for sighted pointer and keyboard users only.
                aria-hidden="true"
                className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 rounded bg-[var(--foreground)] px-2 py-1 text-xs whitespace-nowrap text-[var(--background)] group-hover:block group-focus-visible:block"
              >
                {label}
              </span>
            </li>
          );
        })}
      </ol>

      <div className="mt-1 flex justify-between text-xs text-[var(--muted)]" aria-hidden="true">
        <span>{format(buckets[0]!.start)}</span>
        {buckets.length > 2 ? <span>{format(middle.start)}</span> : null}
        {buckets.length > 1 ? <span>{format(last.start)}</span> : null}
      </div>

      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-[var(--muted)]">Show as a table</summary>
        <table className="mt-2 w-full text-left text-sm">
          <thead>
            <tr className="text-xs text-[var(--muted)]">
              <th scope="col" className="py-1 font-medium">
                From
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Questions
              </th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket) => (
              <tr key={bucket.start} className="border-t border-[var(--border)]">
                <td className="py-1">{format(bucket.start)}</td>
                <td className="py-1 text-right tabular-nums">{bucket.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** Times for short buckets, dates for day-long ones, both when the event spans days. */
function bucketFormatter(
  bucketMinutes: number,
  buckets: EventInsightsResponse['timeline']['buckets'],
): (iso: string) => string {
  const first = new Date(buckets[0]!.start);
  const last = new Date(buckets[buckets.length - 1]!.start);
  const spansDays = first.toDateString() !== last.toDateString();

  const options: Intl.DateTimeFormatOptions =
    bucketMinutes >= 1440
      ? { month: 'short', day: 'numeric' }
      : spansDays
        ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
        : { hour: 'numeric', minute: '2-digit' };

  const formatter = new Intl.DateTimeFormat(undefined, options);
  return (iso) => formatter.format(new Date(iso));
}

function describeMinutes(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? '1 day' : `${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
  return `${minutes} minutes`;
}
