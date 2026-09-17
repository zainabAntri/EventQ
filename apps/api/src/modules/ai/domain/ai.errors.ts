import type { AiFeature } from '@eventq/contracts';
import {
  ConflictError,
  InvariantViolationError,
  ServiceUnavailableError,
} from '../../../shared/errors/domain-error';
import type { AiFailureKind } from './ai-provider.port';

/**
 * AI failures, as an organizer sees them.
 *
 * None of these is ever thrown on an attendee path: the attendee surface has
 * no AI in it, so an AI outage cannot make asking or voting fail. That is what
 * "the core application must continue functioning" means concretely — there
 * is no code path from a public endpoint to a model.
 */

/** Off at the server, off for the event, or no key. Nothing was attempted. */
export class AiDisabledError extends InvariantViolationError {
  constructor(reason: 'server' | 'event') {
    super(
      'AI_DISABLED',
      reason === 'server'
        ? 'AI features are not enabled on this server.'
        : 'AI features are switched off for this event. Turn them on in the AI panel first.',
      { context: { reason } },
    );
  }
}

/**
 * The call would cross a spending cap, so it was not made.
 *
 * Reported BEFORE dispatch, against the ledger. The message says which cap,
 * because an organizer who hits the per-event limit can raise nothing, while
 * the monthly one is the whole organisation's and worth a conversation.
 */
export class AiBudgetExceededError extends InvariantViolationError {
  constructor(scope: 'event' | 'month', spentMicros: number, budgetMicros: number) {
    super(
      'AI_BUDGET_EXCEEDED',
      scope === 'event'
        ? `This event has reached its AI budget ($${dollars(budgetMicros)}). No further AI calls will be made for it.`
        : `The monthly AI budget ($${dollars(budgetMicros)}) has been reached. No further AI calls will be made this month.`,
      { context: { scope, spentMicros, budgetMicros } },
    );
  }
}

/** The same feature is already running for this event. One bill, not two. */
export class AiBusyError extends ConflictError {
  override readonly code = 'AI_BUSY' as const;

  constructor(feature: AiFeature) {
    super(`That AI action is already running for this event. Wait for it to finish.`, {
      context: { feature },
    });
  }
}

/**
 * The provider could not give a usable answer.
 *
 * 503 with a retry hint, because from the organizer's side every one of
 * these — a timeout, an overloaded provider, a malformed reply — means the
 * same thing: try again in a moment, and nothing on the event was changed.
 * The `kind` is kept for the logs; the message deliberately does not expose
 * the vendor's own error text.
 */
export class AiUnavailableError extends ServiceUnavailableError {
  override readonly code = 'AI_PROVIDER_ERROR' as const;

  constructor(kind: AiFailureKind, feature: AiFeature) {
    super(messageFor(kind), { context: { kind, feature } });
  }
}

function messageFor(kind: AiFailureKind): string {
  switch (kind) {
    case 'timeout':
      return 'The AI provider took too long to answer. Nothing was changed; try again in a moment.';
    case 'rate_limited':
      return 'The AI provider is rate limiting requests. Nothing was changed; try again shortly.';
    case 'unavailable':
      return 'The AI provider is temporarily unavailable. Nothing was changed; try again shortly.';
    case 'model_not_found':
      return 'The configured AI model is not available. This needs a configuration change.';
    case 'authentication':
      return 'The AI provider rejected the server’s credentials. This needs a configuration change.';
    case 'invalid_response':
      return 'The AI provider returned something that could not be understood, so it was discarded. Try again.';
    case 'refused':
      return 'The AI provider declined to answer this request.';
    case 'invalid_request':
    case 'unknown':
      return 'The AI request could not be completed. Nothing was changed.';
  }
}

function dollars(micros: number): string {
  return (micros / 1_000_000).toFixed(2);
}
