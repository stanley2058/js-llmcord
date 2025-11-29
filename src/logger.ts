export type LogLevel = "debug" | "info" | "warn" | "error";

export interface ILogger {
  log(level: LogLevel, message: any, ...args: any[]): void;
  logDebug(message: any, ...args: any[]): void;
  logInfo(message: any, ...args: any[]): void;
  logWarn(message: any, ...args: any[]): void;
  logError(message: any, ...args: any[]): void;
}

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export class Logger implements ILogger {
  private logLevel: LogLevel;
  private module: string;

  constructor({
    logLevel = "info",
    module = "",
  }: {
    logLevel?: LogLevel;
    module?: string;
  } = {}) {
    this.logLevel = logLevel;
    this.module = module;
  }

  log(level: LogLevel, message: any, ...args: any[]) {
    if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(this.logLevel)) return;

    let prefix = `[${level}]\t`;
    if (this.module) prefix += `[${this.module}]\t`;
    prefix += `${new Date().toISOString()}`;
    const outputMessage = `${prefix}\t${message}`;

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
}
