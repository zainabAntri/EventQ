import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { AppConfigService } from '../../../shared/config/app-config.service';
import {
  AiProviderFailure,
  type AiCompletion,
  type AiCompletionRequest,
  type AiProvider,
} from '../domain/ai-provider.port';

/**
 * The Anthropic adapter — the ONLY file in EventQ that imports a model SDK.
 *
 * Three decisions here matter more than the rest:
 *
 *   - `maxRetries: 0`. The SDK retries on its own by default; combined with
 *     the runner's retry that would be up to six attempts per click. Retry
 *     policy belongs in exactly one place, and that place is the runner,
 *     where it is bounded, logged and ledgered.
 *
 *   - Structured output. The request asks for the schema's shape and the SDK
 *     parses the reply against it. A reply that does not parse is reported as
 *     `invalid_response` — not thrown as a stack trace, not stored, not
 *     guessed at. This is what "validate AI responses before storing them"
 *     looks like at the boundary.
 *
 *   - Every SDK error is translated into an AiProviderFailure with a kind and
 *     a retryable flag, so nothing upstream knows what an Anthropic exception
 *     is. Replacing the vendor means replacing this file.
 */
@Injectable()
export class AnthropicAiProvider implements AiProvider {
  private readonly client: Anthropic;

  constructor(config: AppConfigService) {
    this.client = new Anthropic({
      apiKey: config.ai.apiKey,
      maxRetries: 0,
    });
  }

  async complete<TOutput>(request: AiCompletionRequest<TOutput>): Promise<AiCompletion<TOutput>> {
    let response;
    try {
      response = await this.client.messages.parse(
        {
          model: request.modelId,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.input }],
          output_config: { format: zodOutputFormat(request.schema) },
        },
        // Milliseconds, in this SDK. The runner's timeout is the hard wall.
        { timeout: request.timeoutMs },
      );
    } catch (caught) {
      throw classifyProviderError(caught);
    }

    if (response.stop_reason === 'refusal') {
      throw new AiProviderFailure('refused', false, 'The model declined the request');
    }
    if (response.stop_reason === 'max_tokens') {
      // A truncated structured reply is not partial data; it is no data.
      throw new AiProviderFailure('invalid_response', false, 'Output was cut off at max_tokens');
    }

    // The SDK parses against the schema; a null here means the reply was not
    // the shape we asked for. Re-validated with Zod so a hostile or garbled
    // reply cannot reach a use-case as a loosely-typed object.
    const validated = request.schema.safeParse(response.parsed_output);
    if (!validated.success) {
      throw new AiProviderFailure('invalid_response', false, 'Output did not match the schema');
    }

    return {
      output: validated.data,
      modelId: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cachedReadTokens: response.usage.cache_read_input_tokens ?? 0,
      },
    };
  }
}

/**
 * SDK error → domain failure. Most specific first, and every branch decides
 * `retryable` explicitly, because the runner will do exactly what this says.
 *
 * Exported so the mapping can be unit-tested against real SDK error classes
 * without a network — the one part of this file whose correctness is a
 * matter of money rather than of style.
 */
export function classifyProviderError(caught: unknown): AiProviderFailure {
  if (caught instanceof AiProviderFailure) return caught;

  // A timeout may already have been billed; it is NOT retryable.
  if (caught instanceof Anthropic.APIConnectionTimeoutError) {
    return new AiProviderFailure('timeout', false, 'Request timed out', { cause: caught });
  }

  if (caught instanceof Anthropic.RateLimitError) {
    const retryAfterSeconds = retryAfterFrom(caught);
    return new AiProviderFailure('rate_limited', true, 'Rate limited by the provider', {
      cause: caught,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    });
  }

  if (caught instanceof Anthropic.NotFoundError) {
    return new AiProviderFailure('model_not_found', false, 'Model not found', { cause: caught });
  }

  if (
    caught instanceof Anthropic.AuthenticationError ||
    caught instanceof Anthropic.PermissionDeniedError
  ) {
    return new AiProviderFailure('authentication', false, 'Provider rejected credentials', {
      cause: caught,
    });
  }

  if (caught instanceof Anthropic.BadRequestError) {
    return new AiProviderFailure('invalid_request', false, 'Provider rejected the request', {
      cause: caught,
    });
  }

  // 5xx and 529 overloaded: the provider did not process the request.
  if (caught instanceof Anthropic.InternalServerError) {
    return new AiProviderFailure('unavailable', true, 'Provider unavailable', { cause: caught });
  }

  // Network failure before any response: nothing was processed.
  if (caught instanceof Anthropic.APIConnectionError) {
    return new AiProviderFailure('unavailable', true, 'Could not reach the provider', {
      cause: caught,
    });
  }

  if (caught instanceof Anthropic.APIError) {
    return new AiProviderFailure('unknown', false, `Provider error ${caught.status ?? ''}`, {
      cause: caught,
    });
  }

  return new AiProviderFailure('unknown', false, 'Unexpected failure', { cause: caught });
}

/** The SDK exposes response headers on its error objects; read defensively,
 *  because the shape is the SDK's to change and a missing hint is fine. */
function retryAfterFrom(error: unknown): number | undefined {
  const headers = (error as { headers?: { get?: (name: string) => string | null | undefined } })
    .headers;
  const header = headers?.get?.('retry-after');
  const seconds = header ? Number(header) : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}
