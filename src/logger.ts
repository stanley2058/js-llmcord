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
  magenta: "\x1b[35m", // for module (fallback)
} as const;

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: COLORS.gray,
  info: COLORS.cyan,
  warn: COLORS.yellow,
  error: COLORS.red,
};

// Simple hash function for consistent module colors
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

// Convert HSL to RGB (h: 0-360, s: 0-1, l: 0-1)
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

// Generate truecolor escape code from module name
function moduleToTruecolor(module: string): string {
  const hue = hashString(module) % 360;
  const [r, g, b] = hslToRgb(hue, 0.7, 0.6); // Fixed saturation/lightness for readability
  return `\x1b[38;2;${r};${g};${b}m`;
}

export class Logger implements ILogger {
  private logLevel: LogLevel;
  private module: string;
  private useColor: boolean;
  private useTruecolor: boolean;
  private moduleColor: string;

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
    this.useTruecolor = this.detectTruecolorSupport();
    this.moduleColor = this.computeModuleColor();
  }

  private detectColorSupport(): boolean {
    if (process.env["NO_COLOR"] !== undefined) return false;
    if (process.env["FORCE_COLOR"] !== undefined) return true;
    return Bun.enableANSIColors;
  }

  private detectTruecolorSupport(): boolean {
    if (!this.useColor) return false;
    const colorterm = process.env["COLORTERM"];
    return colorterm === "truecolor" || colorterm === "24bit";
  }

  private computeModuleColor(): string {
    if (!this.module) return "";
    return this.useTruecolor ? moduleToTruecolor(this.module) : COLORS.magenta;
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
    const moduleTag = this.module
      ? this.colorize(`[${this.module}]`, this.moduleColor) + "\t"
      : "";
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
    this.moduleColor = this.computeModuleColor();
  }
}
