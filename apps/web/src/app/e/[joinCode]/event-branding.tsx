import { brandPalette } from '@eventq/contracts';
import { cn } from '@/lib/cn';

/**
 * Applies one event's branding to everything inside it.
 *
 * ## Why CSS custom properties rather than props
 *
 * The accent reaches a filled button, a vote toggle, a heading and the poster,
 * several component layers apart. Threading four colours through every one of
 * them as props would mean touching each component whenever a fifth surface
 * wants the colour, and would make each of them a place where the wrong
 * contrast-corrected value could be used by mistake.
 *
 * Custom properties invert that: the palette is computed once, here, and each
 * surface reads the variable that matches what it is doing — a fill, text on a
 * fill, or the accent as text. Components stay unaware that branding exists.
 *
 * ## Why this is a Server Component with an inline style
 *
 * The colour is per-event data, so it cannot live in a stylesheet. Setting it
 * inline on a wrapper element during server rendering means the first paint is
 * already branded — no flash of the default indigo before hydration, which on
 * a phone opening a scanned link over mobile data is exactly the sort of jump
 * that reads as a broken page.
 *
 * ## Contrast is not the organizer's problem
 *
 * Every value below comes from `brandPalette`, which corrects the chosen colour
 * where it could not carry readable text. An organizer cannot pick a colour
 * that makes an attendee surface fail WCAG AA, because the colour they pick is
 * not the colour the text sits on — see packages/contracts/src/branding.ts.
 */
export function EventBranding({
  accentColor,
  className,
  children,
}: {
  accentColor: string | null;
  className?: string;
  children: React.ReactNode;
}) {
  const palette = brandPalette(accentColor);

  return (
    <div
      // The class is what globals.css hooks onto to choose between the light
      // and dark ink variants; an inline style cannot answer a media query.
      className={cn('event-branding', className)}
      style={
        {
          '--event-accent': palette.accent,
          '--event-accent-fill': palette.accentFill,
          '--event-on-accent': palette.onAccent,
          '--event-accent-text': palette.accentText,
          '--event-accent-text-dark': palette.accentTextDark,
        } as React.CSSProperties
      }
    >
      {children}
    </div>
  );
}
