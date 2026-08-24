import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Integration-test database harness.
 *
 * Starts a REAL Postgres with pgvector, applies the REAL migrations, and hands
 * back a REAL Prisma client. Nothing here is mocked, on purpose: a mocked ORM
 * verifies the mock, not the query, the index, the constraint or the migration.
 * The unique index that makes double-voting impossible cannot be proven by a
 * test double.
 *
 * The image matches docker-compose.yml and RDS, so a migration that works here
 * works in production.
 */
const POSTGRES_IMAGE = 'pgvector/pgvector:pg16';

/**
 * Locates Prisma's CLI entry script through normal module resolution.
 *
 * Anchored on the working directory rather than `import.meta.url`: this file is
 * typechecked against a CommonJS target (where `import.meta` is illegal) but
 * executed by Vitest as ESM (where `require` does not exist). Resolving from
 * cwd is valid under both.
 */
function resolvePrismaCli(): string {
  return createRequire(join(process.cwd(), 'package.json')).resolve('prisma/build/index.js');
}

export interface TestDatabase {
  prisma: PrismaClient;
  connectionString: string;
  /** Empties every domain table while leaving the schema and migrations intact. */
  truncate(): Promise<void>;
  stop(): Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('eventq_test')
    .withUsername('eventq_test')
    .withPassword('eventq_test')
    .start();

  const connectionString = container.getConnectionUri();

  // Applies migrations exactly as production does. `migrate deploy` rather than
  // `db push`, so the migration files themselves are what gets exercised — a
  // broken migration must fail here, not on a deploy night.
  //
  // The Prisma CLI is invoked through its resolved entry script rather than the
  // `pnpm` wrapper: spawning a .cmd shim needs `shell: true`, which Node now
  // flags (DEP0190) because arguments are concatenated rather than escaped.
  // Running it on the current Node binary avoids a shell entirely.
  execFileSync(process.execPath, [resolvePrismaCli(), 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: connectionString },
    stdio: 'pipe',
  });

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  await prisma.$connect();

  return {
    prisma,
    connectionString,

    async truncate(): Promise<void> {
      // Discovered dynamically rather than hard-coded: a new table added in a
      // later phase is cleaned automatically instead of silently leaking rows
      // between tests.
      const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
      `;
      if (tables.length === 0) return;

      const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
      // CASCADE handles the FK graph; RESTART IDENTITY keeps sequences stable
      // so tests cannot accidentally depend on an incrementing id.
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    },

    async stop(): Promise<void> {
      await prisma.$disconnect();
      await container.stop();
    },
  };
}
