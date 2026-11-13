/**
 * What the game page and the dev server (`scripts/devserver.ts`) say to each other. Plain
 * data only, so the server can import it without the editor or the engine.
 */

/** The dev server's endpoints. All are on the page's own origin. */
export const DEV_ENDPOINTS = {
  /** POST {@link LogBatch}: appends to `.logs/game.log`. */
  log: '/__synergy/log',
  /** POST {@link ReportUpload}: writes `.reports/<time>/` and `.reports/latest/`. Answers {@link SavedAt}. */
  report: '/__synergy/report',
  /** POST {@link ScreenshotUpload}: writes `.screenshots/<name>` (default `dev-<time>.png`). Answers {@link SavedAt}. */
  screenshot: '/__synergy/screenshot',
  /** POST {@link ReportRequest} from `bun run report`: asks an open game page for a report. */
  requestReport: '/__synergy/request-report',
  /** WebSocket the page keeps open, so a tool can ask it for things. */
  socket: '/__synergy/socket',
} as const;

/** Lines for the log file. `session` starts a new file (the old one becomes `game.previous.log`). */
export interface LogBatch {
  readonly session?: string;
  readonly lines: readonly string[];
}

export interface ReportUpload {
  /** PNG data URL, or null. */
  readonly screenshot: string | null;
  readonly files: Readonly<Record<string, string>>;
}

export interface ScreenshotUpload {
  /** PNG data URL. */
  readonly screenshot: string;
  /** File name to save it under; only its last part is used. */
  readonly name?: string;
}

/** Where the server put what it was sent, relative to the project root. */
export interface SavedAt {
  readonly path: string;
}

/** What a tool sends to ask for a report. */
export interface ReportRequest {
  readonly note?: string;
}

/** Messages the server sends down the socket. */
export type ServerMessage = { readonly type: 'report'; readonly id: string; readonly note: string };

/** Messages the page sends up the socket. */
export type PageMessage =
  | { readonly type: 'hello'; readonly url: string }
  | { readonly type: 'reported'; readonly id: string; readonly path: string | null; readonly error?: string };
