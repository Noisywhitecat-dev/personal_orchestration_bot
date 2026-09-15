export type OrchestrationErrorCode =
  | 'INVALID_TRANSITION'
  | 'APPROVAL_REQUIRED'
  | 'REVIEW_ROUNDS_EXCEEDED'
  | 'TASK_NOT_FOUND'
  | 'PROJECT_NOT_FOUND'
  | 'RUN_NOT_FOUND'
  | 'AGENT_RUN_FAILED'
  | 'AGENT_RESULT_INVALID'
  | 'INVALID_PROJECT_ROOT'
  | 'VALIDATION_FAILED'
  | 'INTERNAL';

/**
 * Errors carry a stable machine-readable `code` and a user-facing `message`.
 * `details` is for logs/debugging only and must never contain secrets.
 */
export class OrchestrationError extends Error {
  constructor(
    readonly code: OrchestrationErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OrchestrationError';
  }

  toJSON(): { code: OrchestrationErrorCode; message: string; details?: Record<string, unknown> } {
    return this.details
      ? { code: this.code, message: this.message, details: this.details }
      : { code: this.code, message: this.message };
  }
}

export function isOrchestrationError(err: unknown): err is OrchestrationError {
  return err instanceof OrchestrationError;
}
