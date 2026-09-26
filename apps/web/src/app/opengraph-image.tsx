import { ImageResponse } from 'next/og';
import { BRAND_HEX, SITE_NAME } from '@/lib/site';

/**
 * The card shown when an EventQ link is shared. X uses it too: without a
 * `twitter:image` it falls back to `og:image`.
 *
 * Deliberately generic, and inherited by every route, event pages included. A
 * join link forwarded to a group chat must not preview a private event's title.
 * Rendered once at build time.
 */
export const alt = 'EventQ - Audience Q&A for live events';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '80px 96px',
        background: '#111318',
        color: '#ffffff',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <div
          style={{
            width: 88,
            height: 88,
            borderRadius: 20,
            background: BRAND_HEX,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 58,
            fontWeight: 700,
          }}
        >
          Q
        </div>
        <div style={{ fontSize: 48, fontWeight: 700 }}>{SITE_NAME}</div>
      </div>
      <div style={{ marginTop: 56, fontSize: 68, fontWeight: 700, lineHeight: 1.1 }}>
        Every question from the room, organised.
      </div>
      <div style={{ marginTop: 28, fontSize: 32, color: '#b8bfcc' }}>
        Attendees scan a QR code and ask. No app, no account.
      </div>
    </div>,
    size,
  );
}
