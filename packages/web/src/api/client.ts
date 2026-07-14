import type { WsEvent } from "@meshkeep/shared";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    credentials: "same-origin",
    ...options,
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ApiError(response.status, typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
  }
  return body as T;
}

export type WsStatus = "connecting" | "open" | "closed";

/** Auto-reconnecting WebSocket feed of server events. */
export function connectEvents(
  onEvent: (event: WsEvent) => void,
  onStatus: (status: WsStatus) => void,
): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retryDelay = 1000;

  const open = () => {
    if (closed) return;
    onStatus("connecting");
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${protocol}://${location.host}/api/v1/ws`);
    ws.onopen = () => {
      retryDelay = 1000;
      onStatus("open");
    };
    ws.onmessage = (message) => {
      try {
        onEvent(JSON.parse(message.data as string) as WsEvent);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      onStatus("closed");
      if (!closed) {
        setTimeout(open, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 15_000);
      }
    };
    ws.onerror = () => ws?.close();
  };

  open();
  return () => {
    closed = true;
    ws?.close();
  };
}
