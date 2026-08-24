import { defineConfig, env } from 'prisma/config';

// Prisma 7 no longer auto-loads .env. Node's built-in loader handles it with no
// extra dependency. In CI and on ECS the variables are already in the
// environment, so a missing file is expected and must not be fatal.
try {
  process.loadEnvFile('.env');
} catch {
  // No local .env — rely on the ambient environment.
}

/**
 * Prisma CLI configuration.
 *
 * Prisma 7 removed `url` from the schema's datasource block: migration and
 * introspection commands read the connection string from here, and the runtime
 * client is constructed with a driver adapter instead (see
 * src/shared/prisma/prisma.service.ts).
 *
 * This file is used by the CLI only. It is never imported by application code,
 * so the DATABASE_URL it reads is the developer's or the CI job's — production
 * migrations run as a one-off ECS task with the value injected from Secrets
 * Manager, never baked into an image.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
  migrations: {
    path: 'prisma/migrations',
    // tsx rather than ts-node: it starts fast and needs no separate tsconfig.
    // The seed refuses to run when NODE_ENV is production.
    seed: 'tsx prisma/seed/index.ts',
  },
});
