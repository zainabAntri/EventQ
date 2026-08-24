import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ProblemDetails } from '@eventq/contracts';
import { toOpenApiSchema } from '../validation/zod-dto';
import type { AppConfigService } from '../config/app-config.service';

export const OPENAPI_PATH = 'api/docs';

/**
 * Publishes the OpenAPI document.
 *
 * Off in production by default. The schema describes every endpoint and payload
 * shape, which is a useful map for an attacker and of no use to an attendee
 * scanning a QR code — so it is opt-in rather than opt-out.
 */
export function setupOpenApi(app: INestApplication, config: AppConfigService): void {
  if (config.isProduction) return;

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('EventQ API')
      .setDescription(
        [
          'Event Q&A and audience-engagement platform.',
          '',
          'Three surfaces with different auth and different threat models:',
          '- `/api/v1/public/*` — attendee token, aggressively rate limited',
          '- `/api/v1/*` — organizer session cookie, org-scoped and permission-checked',
          '- `/health/*` — unversioned so probe URLs survive an API version bump',
          '',
          'Every error response is RFC 9457 `application/problem+json`. Branch on',
          '`code`, never on `detail` — `detail` is human-facing and may be reworded.',
        ].join('\n'),
      )
      .setVersion('1.0')
      .addCookieAuth('eq_at', { type: 'apiKey', in: 'cookie' }, 'organizer-session')
      .addCookieAuth('eq_pt', { type: 'apiKey', in: 'cookie' }, 'attendee-token')
      .build(),
    {
      // Documenting the shared error envelope once, rather than repeating it on
      // every endpoint, keeps it accurate as endpoints are added.
      extraModels: [],
    },
  );

  document.components ??= {};
  document.components.schemas ??= {};
  document.components.schemas['ProblemDetails'] = toOpenApiSchema(
    ProblemDetails,
    'output',
  ) as (typeof document.components.schemas)[string];

  SwaggerModule.setup(OPENAPI_PATH, app, document, {
    jsonDocumentUrl: `${OPENAPI_PATH}/json`,
    swaggerOptions: {
      persistAuthorization: true,
      tryItOutEnabled: true,
    },
  });
}
