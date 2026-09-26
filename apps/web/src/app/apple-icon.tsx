import { ImageResponse } from 'next/og';
import { BRAND_HEX } from '@/lib/site';

/**
 * The home-screen icon for iOS, which does not accept the SVG favicon. Rendered
 * once at build time, so it costs nothing per request.
 */
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: BRAND_HEX,
        color: '#ffffff',
        fontSize: 116,
        fontWeight: 700,
      }}
    >
      Q
    </div>,
    size,
  );
}
