import { formatEntry, type LogCapture } from './logs';
import {
  DEV_ENDPOINTS,
  type LogBatch,
  type PageMessage,
  type ReportUpload,
  type SavedAt,
  type ServerMessage,
} from './protocol';

/**
 * The page's side of the dev server (`scripts/devserver.ts`): streams the log to
 * `.logs/game.log`, uploads reports and screenshots, and answers requests from tools
 * such as `bun run report`. Served by anything else (a static server, a deploy), the
 * first request fails and the link goes quiet: the editor still works, without files.
 */
export class DevServerLink {
  private pending: string[] = [];
  private session: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private socket: WebSocket | null = null;
  private retry = 500;
  private closed = false;
  /** False once the server has shown it is not the dev server. */
  available = true;

  constructor(
    private readonly logs: LogCapture,
    private readonly onReportRequest: (note: string) => Promise<string | null>,
  ) {}

  /** Starts a new log file with a header, sends what was logged so far, then follows the log. */
  start(header: string): () => void {
    this.session = header;
    this.pending = this.logs.entries.map(formatEntry);
    const unsubscribe = this.logs.subscribe((entry, replaced) => {
      // A repeated message is written once more with its count; the file is a record, not a view.
      if (!replaced || entry.count % 100 === 0) this.pending.push(formatEntry(entry));
      this.schedule();
    });
    const flushNow = () => this.flush(true);
    addEventListener('pagehide', flushNow);
    this.flush();
    this.connect();
    return () => {
      this.closed = true;
      unsubscribe();
      removeEventListener('pagehide', flushNow);
      this.socket?.close();
    };
  }

  /** Saves a report on the server. Resolves to its folder, or `null` when there is no dev server. */
  async saveReport(report: ReportUpload): Promise<string | null> {
    return this.post(DEV_ENDPOINTS.report, report);
  }

  /** Saves a PNG on the server. Resolves to its path, or `null` when there is no dev server. */
  async saveScreenshot(screenshot: string, name?: string): Promise<string | null> {
    return this.post(DEV_ENDPOINTS.screenshot, { screenshot, name });
  }

  private async post(endpoint: string, body: unknown): Promise<string | null> {
    if (!this.available) return null;
    try {
      const response = await fetch(endpoint, { method: 'POST', body: JSON.stringify(body) });
      if (response.status === 404) this.available = false;
      if (!response.ok) return null;
      return ((await response.json()) as SavedAt).path;
    } catch {
      return null;
    }
  }

  private schedule(): void {
    this.timer ??= setTimeout(() => this.flush(), 400);
  }

  private flush(leaving = false): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.available || (this.pending.length === 0 && this.session === null)) return;
    const batch: LogBatch = { session: this.session ?? undefined, lines: this.pending };
    this.session = null;
    this.pending = [];
    const body = JSON.stringify(batch);
    // While the page closes only a beacon still gets out.
    if (leaving && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(DEV_ENDPOINTS.log, body);
      return;
    }
    // Never log a failure here: it would be captured, sent, and fail again.
    fetch(DEV_ENDPOINTS.log, { method: 'POST', body })
      .then((response) => {
        if (response.status === 404) this.available = false;
      })
      .catch(() => {});
  }

  private connect(): void {
    if (this.closed || !this.available || typeof WebSocket === 'undefined') return;
    const url = new URL(DEV_ENDPOINTS.socket, location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    this.socket = socket;
    const send = (message: PageMessage) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    socket.addEventListener('open', () => {
      this.retry = 500;
      send({ type: 'hello', url: location.href });
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as ServerMessage;
      if (message.type !== 'report') return;
      this.onReportRequest(message.note).then(
        (path) => send({ type: 'reported', id: message.id, path }),
        (error: unknown) => send({ type: 'reported', id: message.id, path: null, error: String(error) }),
      );
    });
    // The dev server restarts when its own code changes; come back when it does.
    socket.addEventListener('close', () => {
      if (this.closed || !this.available) return;
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 10_000);
    });
  }
}
