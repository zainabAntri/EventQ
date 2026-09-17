import type { z } from 'zod';

/**
 * Port: a language model.
 *
 * The whole of EventQ's dependence on any AI vendor is this one interface.
 * Nothing in domain/ or application/ imports a provider SDK; the Anthropic
 * adapter in infrastructure/ is the only file that does, and replacing the
 * vendor means writing one more file like it. That is the "do not tightly
 * couple business logic to a specific AI provider" requirement made
 * structural rather than aspirational — the compiler enforces it, because a
 * use-case has no way to reach the SDK.
 *
 * The contract is deliberately narrow: ONE structured completion. No chat
 * history, no tools, no streaming. Every feature this product has is "here is
 * some text, give me back an object of this exact shape", and an interface
 * that offered more would invite a use-case to depend on more.
 */

export interface AiCompletionRequest<TOutput> {
  /** A provider model id, chosen by the caller's tier — never hardcoded here. */
  modelId: string;
  /** The stable instructions. Kept identical across calls so a provider can cache it. */
  system: string;
  /** The per-call content. Already minimised: nothing personal, nothing secret. */
  input: string;
  /**
   * The shape the answer MUST take. The adapter asks the provider for exactly
   * this structure where supported, and validates the result against it
   * regardless — a response that does not parse is an error, never data.
   */
  schema: z.ZodType<TOutput>;
  maxOutputTokens: number;
  /** Hard wall-clock limit. The adapter must give up, not wait. */
  timeoutMs: number;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the provider's prompt cache, billed at a discount. */
  cachedReadTokens: number;
}

export interface AiCompletion<TOutput> {
  output: TOutput;
  usage: AiUsage;
  /** The model that actually answered, as reported by the provider. */
  modelId: string;
}

/**
 * Why a call failed, as the runner needs to know it.
 *
 * `retryable` is decided HERE, by the adapter that saw the real error, and the
 * runner obeys it without interpretation. Only a transient provider condition
 * is retryable. A timeout is NOT: the request may already have been billed,
 * and repeating it doubles the cost of a slow answer.
 */
export type AiFailureKind =
  | 'timeout'
  | 'rate_limited'
  | 'unavailable'
  | 'model_not_found'
  | 'authentication'
  | 'invalid_request'
  | 'invalid_response'
  | 'refused'
  | 'unknown';

export class AiProviderFailure extends Error {
  constructor(
    readonly kind: AiFailureKind,
    readonly retryable: boolean,
    message: string,
    options?: { cause?: unknown; retryAfterSeconds?: number },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AiProviderFailure';
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }

  readonly retryAfterSeconds: number | undefined;
}

export interface AiProvider {
  /**
   * One structured completion.
   *
   * Resolves with a validated object, or rejects with AiProviderFailure and
   * NOTHING ELSE — an adapter must translate every vendor error, so the
   * runner never has to know what a vendor's exceptions look like.
   */
  complete<TOutput>(request: AiCompletionRequest<TOutput>): Promise<AiCompletion<TOutput>>;
}

export const AI_PROVIDER = Symbol('AI_PROVIDER');
