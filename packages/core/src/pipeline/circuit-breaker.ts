// ============================================================================
// Circuit Breaker — Escalating retry strategy for render pipeline
// ============================================================================
//
// Three-round escalation:
//   Round 1: retry (standard retry with same prompt)
//   Round 2: prompt_fix (retry with repair guidance injected)
//   Round 3: abort (stop trying, mark for review)
// ============================================================================
import {
  AuthError,
  ModelNotFoundError,
  RateLimitError,
  TimeoutError,
  ValidationError,
} from '../errors.ts';

/**
 * Retry strategy result.
 */
export interface RetryStrategy {
  shouldRetry: boolean;
  delayMs: number;
  strategy: 'backoff' | 'jitter' | 'immediate_abort' | 'no_retry';
}

/**
 * Determine retry strategy based on the error type.
 * Used externally by callers to decide how to handle a failed attempt.
 */
export function getRetryStrategy(error: unknown, attempt: number = 0): RetryStrategy {
  if (error instanceof RateLimitError) {
    return {
      shouldRetry: true,
      delayMs: 1000 * (attempt + 1),
      strategy: 'backoff',
    };
  }
  if (error instanceof TimeoutError) {
    return {
      shouldRetry: true,
      delayMs: 500 + Math.random() * 1000,
      strategy: 'jitter',
    };
  }
  if (error instanceof AuthError) {
    return {
      shouldRetry: false,
      delayMs: 0,
      strategy: 'immediate_abort',
    };
  }
  if (error instanceof ModelNotFoundError) {
    return {
      shouldRetry: false,
      delayMs: 0,
      strategy: 'immediate_abort',
    };
  }
  if (error instanceof ValidationError) {
    return {
      shouldRetry: false,
      delayMs: 0,
      strategy: 'no_retry',
    };
  }
  // Default: transient/unknown error → backoff with fixed delay
  return {
    shouldRetry: true,
    delayMs: 500,
    strategy: 'backoff',
  };
}

export interface CircuitBreakerState {
  round: number; // 1-3
  totalAttempts: number;
  consecutiveFailures: number;
  lastError?: string;
  isOpen: boolean; // true = stop trying
  escalatedStrategy: 'retry' | 'prompt_fix' | 'abort';
}

export interface CircuitBreakerConfig {
  maxRounds: number; // default 3
  maxAttemptsPerRound: number; // default 2
  failureThreshold: number; // default 3
  escalationDelay: number; // ms between rounds, default 0
}

export function createCircuitBreaker(config?: Partial<CircuitBreakerConfig>): {
  state: () => CircuitBreakerState;
  attempt: () => boolean; // returns true if should try again
  recordSuccess: () => void;
  recordFailure: (error: string) => void;
  escalate: () => boolean; // returns true if escalated to next round
  reset: () => void;
} {
  const cfg: CircuitBreakerConfig = {
    maxRounds: 3,
    maxAttemptsPerRound: 2,
    failureThreshold: 3,
    escalationDelay: 0,
    ...config,
  };

  let s: CircuitBreakerState = {
    round: 1,
    totalAttempts: 0,
    consecutiveFailures: 0,
    isOpen: false,
    escalatedStrategy: 'retry',
  };

  return {
    state: () => ({ ...s }),

    attempt: () => {
      if (s.isOpen) return false;
      if (s.totalAttempts >= cfg.maxRounds * cfg.maxAttemptsPerRound) {
        s.isOpen = true;
        s.escalatedStrategy = 'abort';
        return false;
      }
      s.totalAttempts++;
      return true;
    },

    recordSuccess: () => {
      s.consecutiveFailures = 0;
    },

    recordFailure: (error: string) => {
      s.consecutiveFailures++;
      s.lastError = error;
      if (s.consecutiveFailures >= cfg.failureThreshold) {
        s.isOpen = true;
      }
    },

    escalate: () => {
      if (s.round >= cfg.maxRounds) {
        s.isOpen = true;
        s.escalatedStrategy = 'abort';
        return false;
      }
      s.round++;
      s.consecutiveFailures = 0;
      if (s.round === 2) {
        s.escalatedStrategy = 'prompt_fix';
      } else if (s.round >= 3) {
        s.escalatedStrategy = 'abort';
      }
      return true;
    },

    reset: () => {
      s = {
        round: 1,
        totalAttempts: 0,
        consecutiveFailures: 0,
        isOpen: false,
        escalatedStrategy: 'retry',
      };
    },
  };
}
