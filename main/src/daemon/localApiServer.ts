import http, { type IncomingMessage, type ServerResponse } from 'http';
import { terminalPanelManager } from '../services/terminalPanelManager';

const LOCAL_API_PORT = 11777;
const LOCAL_API_MAX_PORT = 11797; // try up to 20 ports (11777–11796)
const LOCAL_API_HOST = '0.0.0.0';

type ExternalActivityStatus = 'active' | 'idle' | 'waiting_for_input';

interface LocalApiResponse {
  ok: boolean;
  error?: string;
  matched?: string;
}

export class PaneLocalApiServer {
  private server: http.Server | null = null;
  private port: number = LOCAL_API_PORT;
  private static activeInstance: PaneLocalApiServer | null = null;

  static getActivePort(): number {
    return PaneLocalApiServer.activeInstance?.port ?? LOCAL_API_PORT;
  }

  getPort(): number {
    return this.port;
  }

  async start(preferredPort?: number): Promise<void> {
    if (this.server) {
      throw new Error('Pane local API server is already running');
    }

    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!response.headersSent) {
          this.writeJson(response, 500, { ok: false, error: message });
          return;
        }
        response.destroy(new Error(message));
      });
    });

    const startPort = preferredPort ?? LOCAL_API_PORT;

    let lastError: Error | undefined;
    for (let port = startPort; port <= LOCAL_API_MAX_PORT; port++) {
      try {
        await this.tryListen(server, port);
        this.server = server;
        this.port = port;
        PaneLocalApiServer.activeInstance = this;
        console.warn(`[Pane local API] Listening on http://${LOCAL_API_HOST}:${port}`);
        return;
      } catch (error) {
        lastError = error as Error;
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          console.warn(`[Pane local API] Port ${port} in use, trying ${port + 1}...`);
          continue;
        }
        throw error;
      }
    }

    this.server = null;
    throw new Error(
      `All ports from ${startPort} to ${LOCAL_API_MAX_PORT} are in use`,
      { cause: lastError },
    );
  }

  private tryListen(server: http.Server, port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, LOCAL_API_HOST);
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (PaneLocalApiServer.activeInstance === this) {
      PaneLocalApiServer.activeInstance = null;
    }

    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    // CORS for localhost dev
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      });
      response.end();
      return;
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      response.end(JSON.stringify({ ok: true, status: 'ready' }));
      return;
    }

    if (url.pathname === '/terminal/activity' && request.method === 'POST') {
      await this.handleTerminalActivity(request, response);
      return;
    }

    this.writeJson(response, 404, { ok: false, error: `Endpoint "${url.pathname}" not found` });
  }

  private async handleTerminalActivity(request: IncomingMessage, response: ServerResponse): Promise<void> {
    console.log('[Pane local API] Incoming request: POST /terminal/activity');
    const body = await this.readBody(request);

    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      this.writeJson(response, 400, { ok: false, error: 'Invalid JSON body' });
      return;
    }

    if (!isActivityRequest(parsed)) {
      console.warn('[Pane local API] 400 invalid body:', body);
      this.writeJson(response, 400, {
        ok: false,
        error: 'Body must be { "identifier": string, "status": "active" | "idle" | "waiting_for_input" }',
      });
      return;
    }

    const found = terminalPanelManager.setExternalActivityStatus(
      parsed.identifier,
      parsed.status,
    );

    if (!found) {
      console.warn(`[Pane local API] 404 no match for identifier="${parsed.identifier}" status="${parsed.status}"`);
      this.writeJson(response, 404, {
        ok: false,
        error: `No terminal found matching "${parsed.identifier}"`,
      });
      return;
    }

    console.log(`[Pane local API] activity: identifier="${parsed.identifier}" status="${parsed.status}"`);
    this.writeJson(response, 200, { ok: true, matched: parsed.identifier });
  }

  private writeJson(response: ServerResponse, statusCode: number, payload: LocalApiResponse): void {
    response.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    response.end(JSON.stringify(payload));
  }

  private async readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}

interface ActivityRequest {
  identifier: string;
  status: ExternalActivityStatus;
}

function isActivityRequest(value: unknown): value is ActivityRequest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ActivityRequest>;
  return (
    typeof candidate.identifier === 'string' &&
    candidate.identifier.length > 0 &&
    (candidate.status === 'active' || candidate.status === 'idle' || candidate.status === 'waiting_for_input')
  );
}
