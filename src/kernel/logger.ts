/**
 * The only thing in Harbor allowed to write to a stream.
 *
 * Keeping output in one place is what makes it possible to add a second
 * surface later without every module deciding for itself how to print.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Primary output. Always written, regardless of level. */
  print(message: string): void;
}

/**
 * Piping Harbor into `head` closes stdout early, and an unhandled EPIPE takes
 * the process down with a stack trace. Swallowing it here is correct: the
 * reader went away on purpose.
 */
function guardStreams(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") {
        throw error;
      }
    });
  }
}

export function createLogger(level: LogLevel = "info"): Logger {
  guardStreams();
  const threshold = RANK[level];

  const emit = (at: LogLevel, message: string): void => {
    if (RANK[at] < threshold) {
      return;
    }
    const stream = RANK[at] >= RANK.warn ? process.stderr : process.stdout;
    stream.write(`${message}\n`);
  };

  return {
    debug: (message: string): void => {
      emit("debug", `  ${message}`);
    },
    info: (message: string): void => {
      emit("info", message);
    },
    warn: (message: string): void => {
      emit("warn", `warning: ${message}`);
    },
    error: (message: string): void => {
      emit("error", `error: ${message}`);
    },
    print: (message: string): void => {
      process.stdout.write(`${message}\n`);
    },
  };
}
