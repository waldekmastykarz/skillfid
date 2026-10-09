// Exit codes: 1 generic failure, 2 usage, 3 incomplete work that `--resume` can finish, 4 operation already running,
// 5 quality gate not met (results are still written), 130 interrupted.
export const EXIT_CODES = Object.freeze({ failure: 1, usage: 2, incomplete: 3, locked: 4, gate: 5, interrupted: 130 });

export class SkillfidError extends Error {
  constructor(message, { code = 'ERROR', exitCode = EXIT_CODES.failure, remedy, command, details, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.exitCode = exitCode;
    this.remedy = remedy;
    this.command = command;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(this.remedy ? { remedy: this.remedy } : {}), ...(this.command ? { command: this.command } : {}), ...(this.details ? { details: this.details } : {}) };
  }
}

export class UsageError extends SkillfidError {
  constructor(message, options = {}) { super(message, { code: 'USAGE', exitCode: EXIT_CODES.usage, ...options }); }
}

export class OperationLockedError extends SkillfidError {
  constructor(message, options = {}) { super(message, { code: 'OPERATION_LOCKED', exitCode: EXIT_CODES.locked, ...options }); }
}

export function errorPayload(error) {
  if (error instanceof SkillfidError) return error.toJSON();
  return { code: 'ERROR', message: error?.message ?? String(error) };
}
