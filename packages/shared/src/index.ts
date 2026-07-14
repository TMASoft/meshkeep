export type ConnectionTransport = "serial" | "tcp" | "ble" | "none";

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "syncing"
  | "connected"
  | "standby"
  | "error";

export type ContactType = "chat" | "repeater" | "room" | "none";

export interface SelfInfo {
  publicKey: string;
  name: string;
  type: number;
  txPower: number;
  maxTxPower: number;
  lat: number | null;
  lon: number | null;
  radioFreq: number;
  radioBw: number;
  radioSf: number;
  radioCr: number;
  firmwareVer?: number | null;
  firmwareBuildDate?: string | null;
  manufacturerModel?: string | null;
}

export interface Contact {
  publicKey: string;
  name: string;
  type: ContactType;
  flags: number;
  outPathLen: number;
  lat: number | null;
  lon: number | null;
  lastAdvert: number;
  lastSeen: number | null;
}

export interface Channel {
  idx: number;
  name: string;
  secret: string;
}

export type MessageKind = "dm" | "channel";
export type MessageDirection = "in" | "out";
export type MessageStatus = "pending" | "sent" | "delivered" | "failed";

export interface Message {
  id: number;
  kind: MessageKind;
  contactKey: string | null;
  contactName?: string | null;
  channelIdx: number | null;
  channelName?: string | null;
  direction: MessageDirection;
  text: string;
  senderTimestamp: number;
  pathLen: number | null;
  status: MessageStatus;
  createdAt: number;
}

export interface ConnectionStatus {
  state: ConnectionState;
  transport: ConnectionTransport;
  target: string | null;
  lastError: string | null;
  connectedAt: number | null;
}

export interface AppStatus {
  connection: ConnectionStatus;
  self: SelfInfo | null;
  batteryMilliVolts: number | null;
  counts: {
    contacts: number;
    messages: number;
    unread: number;
  };
  version: string;
}

export interface MapNode {
  publicKey: string;
  name: string;
  type: ContactType;
  lat: number;
  lon: number;
  lastSeen?: number | null;
  local?: boolean;
}

// WebSocket events pushed by the server to browsers.
export type WsEvent =
  | { type: "status.changed"; status: AppStatus }
  | { type: "message.new"; message: Message }
  | { type: "message.status"; id: number; status: MessageStatus }
  | { type: "contact.updated"; contact: Contact }
  | { type: "self.updated"; self: SelfInfo }
  | { type: "telemetry"; batteryMilliVolts: number; ts: number };

export const CONTACT_TYPE_FROM_ADV: Record<number, ContactType> = {
  0: "none",
  1: "chat",
  2: "repeater",
  3: "room",
};
