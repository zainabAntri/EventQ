import { z } from 'zod';

/**
 * Client-visible configuration, validated at module load.
 *
 * NEXT_PUBLIC_* values are inlined into the browser bundle, so only
 * non-sensitive values may live here. Anything secret belongs to the API.
 *
 * The literal `process.env.X` references are deliberate: Next replaces them at
 * build time by static analysis, so `process.env[key]` would silently produce
 * undefined in the browser.
 */
const publicEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.url(),
  NEXT_PUBLIC_SITE_URL: z.url(),
});

const parsed = publicEnvSchema.safeParse({
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
});

if (!parsed.success) {
  const problems = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid public environment configuration:\n${problems}`);
}

export const env = parsed.data;
