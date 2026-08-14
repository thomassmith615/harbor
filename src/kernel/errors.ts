/**
 * Typed errors with stable codes, carried forward from the prototype.
 *
 * Anything that reaches the process boundary should be a HarborError with a
 * code a script can branch on and an exit code a shell can branch on.
 */

export const EXIT_CODES = {
  success: 0,
  failure: 1,
  usage: 2,
  precondition: 4,
  configuration: 5,
  upstream: 6,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export interface HarborErrorOptions {
  readonly code: string;
  readonly exitCode?: ExitCode;
  readonly hint?: string;
  readonly cause?: unknown;
}

export class HarborError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly hint: string | undefined;

  constructor(message: string, options: HarborErrorOptions) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "HarborError";
    this.code = options.code;
    this.exitCode = options.exitCode ?? EXIT_CODES.failure;
    this.hint = options.hint;
  }
}

export class PreconditionError extends HarborError {
  constructor(message: string, hint?: string) {
    super(message, {
      code: "precondition",
      exitCode: EXIT_CODES.precondition,
      ...(hint === undefined ? {} : { hint }),
    });
    this.name = "PreconditionError";
  }
}

export class ConfigurationError extends HarborError {
  constructor(message: string, hint?: string) {
    super(message, {
      code: "configuration",
      exitCode: EXIT_CODES.configuration,
      ...(hint === undefined ? {} : { hint }),
    });
    this.name = "ConfigurationError";
  }
}

/** A source or model provider misbehaved. Distinct from our own bugs. */
export class UpstreamError extends HarborError {
  readonly status: number | undefined;

  constructor(
    message: string,
    options: {
      status?: number | undefined;
      hint?: string | undefined;
      cause?: unknown;
    } = {},
  ) {
    super(message, {
      code: "upstream",
      exitCode: EXIT_CODES.upstream,
      ...(options.hint === undefined ? {} : { hint: options.hint }),
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = "UpstreamError";
    this.status = options.status;
  }
}
