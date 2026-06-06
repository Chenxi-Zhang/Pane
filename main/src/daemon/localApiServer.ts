import http, { type IncomingMessage, type ServerResponse } from 'http';
import { terminalPanelManager } from '../services/terminalPanelManager';

const LOCAL_API_PORT = 11777;
const LOCAL_API_HOST = '127.0.0.1';

type ExternalActivityStatus = 'active' | 'idle';

interface LocalApiResponse {
  ok: boolean;
  error?: string;
  matched?: string;
}

export class PaneLocalApiServer {
  private server: http.Server | null = null;
  private port: number = LOCAL_API_PORT;

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

    const tryPort = preferredPort ?? LOCAL_API_PORT;

    await new Promise<void>((resolve, reject) => {
      const handleError = (error: Error) => {
        server.removeListener('listening', handleListening);
        this.server = null;
        reject(error);
      };

      const handleListening = () => {
        server.removeListener('error', handleError);
        resolve();
      };

      server.once('error', handleError);
      server.once('listening', handleListening);
      server.listen(tryPort, LOCAL_API_HOST);
    });

    server.on('error', (error) => {
      console.error('[Pane local API] HTTP server error:', error);
    });

    this.server = server;

    const address = server.address();
    if (address && typeof address === 'object') {
      this.port = address.port;
    }

    console.warn(`[Pane local API] Listening on http://${LOCAL_API_HOST}:${this.port}`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;

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
        error: 'Body must be { "identifier": string, "status": "active" | "idle" }',
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
    (candidate.status === 'active' || candidate.status === 'idle')
  );
}
