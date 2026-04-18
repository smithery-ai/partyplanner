export class SkipError extends Error {
  readonly kind = "skip" as const;
  constructor(public stepId: string) {
    super(`Step "${stepId}" skipped`);
    this.name = "SkipError";
  }
}

export class WaitError extends Error {
  readonly kind = "wait" as const;
  constructor(public inputId: string) {
    super(`Waiting for input "${inputId}"`);
    this.name = "WaitError";
  }
}

export class NotReadyError extends Error {
  readonly kind = "not_ready" as const;
  constructor(public dependencyId: string) {
    super(`Dependency "${dependencyId}" is not resolved yet`);
    this.name = "NotReadyError";
  }
}

export function isControlFlowError(
  e: unknown
): e is SkipError | WaitError | NotReadyError {
  return e instanceof SkipError || e instanceof WaitError || e instanceof NotReadyError;
}
