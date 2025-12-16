export type LogLevel = "debug" | "info" | "warn" | "error";

export interface ILogger {
  log(level: LogLevel, message: any, ...args: any[]): void;
  logDebug(message: any, ...args: any[]): void;
  logInfo(message: any, ...args: any[]): void;
  logWarn(message: any, ...args: any[]): void;
  logError(message: any, ...args: any[]): void;
}

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

// ANSI color codes
const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m", // for timestamp
  gray: "\x1b[90m", // for debug
  cyan: "\x1b[36m", // for info
  yellow: "\x1b[33m", // for warn
  red: "\x1b[31m", // for error
} as const;

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: COLORS.gray,
  info: COLORS.cyan,
  warn: COLORS.yellow,
  error: COLORS.red,
};

export class Logger implements ILogger {
  private logLevel: LogLevel;
  private module: string;
  private useColor: boolean;

  constructor({
    logLevel = "info",
    module = "",
  }: {
    logLevel?: LogLevel;
    module?: string;
  } = {}) {
    this.logLevel = logLevel;
    this.module = module;
    this.useColor = this.detectColorSupport();
  }

  private detectColorSupport(): boolean {
    if (process.env["NO_COLOR"] !== undefined) return false;
    if (process.env["FORCE_COLOR"] !== undefined) return true;
    return Bun.enableANSIColors;
  }

  private colorize(text: string, color: string): string {
    if (!this.useColor) return text;
    return `${color}${text}${COLORS.reset}`;
  }

  log(level: LogLevel, message: any, ...args: any[]) {
    if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(this.logLevel)) return;

    const timestamp = this.colorize(new Date().toISOString(), COLORS.dim);
    const levelTag = this.colorize(
      `[${level.toUpperCase()}]`,
      LEVEL_COLORS[level],
    );
    const moduleTag = this.module ? `[${this.module}]\t` : "";
    const outputMessage = `${timestamp}\t${levelTag}\t${moduleTag}${message}`;

    console[level](outputMessage, ...args);
  }

  logDebug(message: any, ...args: any[]) {
    this.log("debug", message, ...args);
  }

  logInfo(message: any, ...args: any[]) {
    this.log("info", message, ...args);
  }

  logWarn(message: any, ...args: any[]) {
    this.log("warn", message, ...args);
  }

  logError(message: any, ...args: any[]) {
    this.log("error", message, ...args, new Error().stack);
  }

  setLogLevel(level: LogLevel) {
    this.logLevel = level;
  }

  setModule(module: string) {
    this.module = module;
  }
}
