import { EventEmitter } from "node:events";
import type { WsEvent } from "@meshkeep/shared";

/** In-process event bus; the WS hub fans these out to browsers. */
export class Bus extends EventEmitter {
  publish(event: WsEvent): void {
    this.emit("event", event);
  }

  subscribe(listener: (event: WsEvent) => void): () => void {
    this.on("event", listener);
    return () => this.off("event", listener);
  }
}
