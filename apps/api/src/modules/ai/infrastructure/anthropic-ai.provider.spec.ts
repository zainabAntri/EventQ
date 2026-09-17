import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { classifyProviderError } from './anthropic-ai.provider';

/**
 * The SDK-error → domain-failure mapping, against the SDK's REAL error
 * classes. This is the one part of the adapter whose correctness is a matter
 * of money: `retryable` is what the runner obeys, and a timeout wrongly marked
 * retryable would double-bill every slow answer.
 */

const headers = new Headers();

function status(code: number, type: string) {
  // The SDK's factory picks the subclass from the status code, exactly as it
  // does for a real response — so these are the instances production sees.
  return Anthropic.APIError.generate(code, { type, message: 'x' }, 'x', headers);
}

describe('classifying provider errors', () => {
  it('marks a timeout as NOT retryable (it may already be billed)', () => {
    const failure = classifyProviderError(new Anthropic.APIConnectionTimeoutError());

    expect(failure.kind).toBe('timeout');
    expect(failure.retryable).toBe(false);
  });

  it('marks a rate limit as retryable', () => {
    const failure = classifyProviderError(status(429, 'rate_limit_error'));

    expect(failure.kind).toBe('rate_limited');
    expect(failure.retryable).toBe(true);
  });

  it('reads a retry-after hint when the provider gives one', () => {
    const withHint = new Headers({ 'retry-after': '7' });
    const error = Anthropic.APIError.generate(
      429,
      { type: 'rate_limit_error', message: 'x' },
      'x',
      withHint,
    );

    expect(classifyProviderError(error).retryAfterSeconds).toBe(7);
  });

  it('marks an overloaded provider (529) as retryable and unavailable', () => {
    const failure = classifyProviderError(status(529, 'overloaded_error'));

    expect(failure.kind).toBe('unavailable');
    expect(failure.retryable).toBe(true);
  });

  it('marks a 500 as retryable and unavailable', () => {
    expect(classifyProviderError(status(500, 'api_error'))).toMatchObject({
      kind: 'unavailable',
      retryable: true,
    });
  });

  it('marks a network failure before any response as retryable', () => {
    const failure = classifyProviderError(
      new Anthropic.APIConnectionError({ message: 'ECONNRESET' }),
    );

    expect(failure.kind).toBe('unavailable');
    expect(failure.retryable).toBe(true);
  });

  it('marks an unknown model as a configuration problem, not retryable', () => {
    expect(classifyProviderError(status(404, 'not_found_error'))).toMatchObject({
      kind: 'model_not_found',
      retryable: false,
    });
  });

  it.each([401, 403])('marks %s as a credentials problem, not retryable', (code) => {
    expect(classifyProviderError(status(code, 'authentication_error'))).toMatchObject({
      kind: 'authentication',
      retryable: false,
    });
  });

  it('marks a 400 as our mistake, not retryable', () => {
    expect(classifyProviderError(status(400, 'invalid_request_error'))).toMatchObject({
      kind: 'invalid_request',
      retryable: false,
    });
  });

  it('never marks something it does not recognise as retryable', () => {
    expect(classifyProviderError(new Error('???'))).toMatchObject({
      kind: 'unknown',
      retryable: false,
    });
    expect(classifyProviderError('a string')).toMatchObject({ kind: 'unknown', retryable: false });
  });

  it('keeps the original error as the cause for the logs, off the message', () => {
    const original = status(500, 'api_error');
    const failure = classifyProviderError(original);

    expect(failure.cause).toBe(original);
    expect(failure.message).not.toContain('api_error');
  });
});
