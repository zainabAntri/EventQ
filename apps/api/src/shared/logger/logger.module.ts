import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { TRACE_ID_HEADER } from '@eventq/contracts';
import { AppConfigModule } from '../config/config.module';
import { AppConfigService } from '../config/app-config.service';

/**
 * Structured logging.
 *
 * Every log line carries a correlation id, and that same id is returned to the
 * client in the error body and the x-trace-id header. A user-reported failure
 * therefore maps to exact log lines without asking them to reproduce it.
 *
 * PII redaction uses an ALLOWLIST mindset: anything that could carry attendee
 * or credential data is redacted by path. A blocklist would silently leak the
 * next field someone adds.
 */
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.logLevel,

          // Reuse an upstream correlation id when the load balancer or the web
          // app already issued one, so a trace spans the whole request path.
          genReqId: (req, res) => {
            const existing = req.headers[TRACE_ID_HEADER];
            const id =
              typeof existing === 'string' && existing.length > 0 ? existing : randomUUID();
            res.setHeader(TRACE_ID_HEADER, id);
            // Makes the id readable by the exception filter.
            req.headers[TRACE_ID_HEADER] = id;
            return id;
          },

          // Health checks would otherwise dominate the log volume.
          autoLogging: {
            ignore: (req) => req.url?.startsWith('/health') === true,
          },

          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
              'req.body.password',
              'req.body.currentPassword',
              'req.body.newPassword',
              'req.body.token',
              'req.body.refreshToken',
              // Attendee identity is PII under the event's identity mode.
              'req.body.email',
              'req.body.displayName',
              'req.body.company',
            ],
            censor: '[redacted]',
          },

          serializers: {
            req: (req) => ({
              id: req.id,
              method: req.method,
              url: req.url,
              // Deliberately omits headers and body: see redact above.
            }),
            res: (res) => ({ statusCode: res.statusCode }),
          },

          // Human-readable locally, JSON everywhere else so CloudWatch and any
          // log pipeline can parse it without a custom grok pattern.
          //
          // Spread rather than `transport: undefined` — under
          // exactOptionalPropertyTypes an explicit undefined is not the same as
          // an absent key, and pino's types reject the former.
          ...(config.isProduction
            ? {}
            : {
                transport: {
                  target: 'pino-pretty',
                  options: {
                    singleLine: true,
                    colorize: true,
                    translateTime: 'HH:MM:ss.l',
                    ignore: 'pid,hostname',
                  },
                },
              }),
        },
      }),
    }),
  ],
})
export class AppLoggerModule {}
