import { defineStore } from "pinia";
import type {
  AppStatus,
  Channel,
  ConnectionState,
  Contact,
  Message,
  NodeStats,
  SensorReading,
  WsEvent,
} from "@meshkeep/shared";
import { api, ApiError, connectEvents, type WsStatus } from "../api/client";
import { BrowserRadioSource, type BrowserRadioKind } from "../sources/browser-radio";

// lives outside the store: holds a live connection object, must not be reactive
let browserSource: BrowserRadioSource | null = null;

export type ConversationId = { kind: "dm"; contactKey: string } | { kind: "channel"; channelIdx: number };

export function conversationKey(id: ConversationId): string {
  return id.kind === "dm" ? `dm:${id.contactKey}` : `ch:${id.channelIdx}`;
}

export const useAppStore = defineStore("app", {
  state: () => ({
    status: null as AppStatus | null,
    session: null as { passwordRequired: boolean; authorized: boolean } | null,
    wsStatus: "connecting" as WsStatus,
    contacts: [] as Contact[],
    channels: [] as Channel[],
    // messages per conversation key, ascending by id
    conversations: {} as Record<string, Message[]>,
    recent: [] as Message[],
    activeConversation: null as ConversationId | null,
    unread: {} as Record<string, number>,
    // room servers / repeaters this session has authenticated with
    nodeLogins: {} as Record<string, boolean>,
    loaded: false,
    stopEvents: null as null | (() => void),
    browserRadio: null as null | {
      kind: BrowserRadioKind;
      state: ConnectionState;
      error: string | null;
      privateSession: boolean;
      batteryMilliVolts: number | null;
    },
  }),

  getters: {
    connectionState: (state): ConnectionState =>
      state.browserRadio ? state.browserRadio.state : state.status?.connection.state ?? "disconnected",
    /** What is driving the radio right now. */
    radioDriver: (state): "server" | BrowserRadioKind => state.browserRadio?.kind ?? "server",
    self: (state) => state.status?.self ?? null,
    batteryPercent: (state): number | null => {
      const mv = state.browserRadio?.batteryMilliVolts ?? state.status?.batteryMilliVolts;
      if (!mv) return null;
      // rough LiPo curve: 3.3V empty → 4.2V full
      return Math.max(0, Math.min(100, Math.round(((mv - 3300) / 900) * 100)));
    },
    chatContacts: (state) => state.contacts.filter((c) => c.type === "chat"),
    needsLogin: (state) => state.session !== null && state.session.passwordRequired && !state.session.authorized,
  },

  actions: {
    async bootstrap() {
      if (this.loaded) return;
      this.session = await api<{ passwordRequired: boolean; authorized: boolean }>("/auth/session");
      if (this.needsLogin) return; // LoginGate takes over; bootstrap resumes after login()
      await Promise.all([this.refreshStatus(), this.refreshContacts(), this.refreshChannels()]);
      this.stopEvents = connectEvents(
        (event) => this.onEvent(event),
        (status) => {
          this.wsStatus = status;
        },
      );
      this.loaded = true;
    },

    async login(password: string) {
      try {
        await api("/auth/login", { method: "POST", body: JSON.stringify({ password }) });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          throw new Error("Wrong password");
        }
        throw error;
      }
      this.session = { passwordRequired: true, authorized: true };
      await this.bootstrap();
    },

    async logout() {
      await api("/auth/logout", { method: "POST" }).catch(() => {});
      // drop all in-memory state along with the session
      location.reload();
    },

    async refreshStatus() {
      this.status = await api<AppStatus>("/status");
    },

    async refreshContacts() {
      const { contacts } = await api<{ contacts: Contact[] }>("/contacts");
      this.contacts = contacts;
    },

    async refreshChannels() {
      const { channels } = await api<{ channels: Channel[] }>("/channels");
      this.channels = channels;
    },

    async openConversation(id: ConversationId) {
      this.activeConversation = id;
      const key = conversationKey(id);
      const query =
        id.kind === "dm" ? `contact=${encodeURIComponent(id.contactKey)}` : `channel=${id.channelIdx}`;
      const { messages } = await api<{ messages: Message[] }>(`/messages?${query}&limit=100`);
      // Messages can arrive over the WebSocket while history is loading. Preserve
      // those newer objects (including delivery-state updates) when merging.
      const merged = new Map(messages.map((message) => [message.id, message]));
      for (const message of this.conversations[key] ?? []) merged.set(message.id, message);
      this.conversations[key] = [...merged.values()].sort((a, b) => a.id - b.id);
      if (this.activeConversation && conversationKey(this.activeConversation) === key) {
        this.unread[key] = 0;
      }
      void api("/messages/read", {
        method: "POST",
        body: JSON.stringify(id.kind === "dm" ? { contact: id.contactKey } : { channel: id.channelIdx }),
      }).catch(() => {});
    },

    async sendMessage(id: ConversationId, text: string) {
      // messages to repeaters are CLI commands, like the official app's remote console
      const cli =
        id.kind === "dm" &&
        this.contacts.find((c) => c.publicKey === id.contactKey)?.type === "repeater";
      if (browserSource && this.browserRadio?.state === "connected") {
        const message =
          id.kind === "dm"
            ? await browserSource.sendDirectMessage(id.contactKey, text, cli)
            : await browserSource.sendChannelMessage(id.channelIdx, text);
        this.appendMessage(message);
        return;
      }
      if (cli && id.kind === "dm") {
        const { message } = await api<{ message: Message }>(`/contacts/${id.contactKey}/cli`, {
          method: "POST",
          body: JSON.stringify({ command: text }),
        });
        this.appendMessage(message);
        return;
      }
      const body =
        id.kind === "dm"
          ? { kind: "dm" as const, to: id.contactKey, text }
          : { kind: "channel" as const, channelIdx: id.channelIdx, text };
      const { message } = await api<{ message: Message }>("/messages", {
        method: "POST",
        body: JSON.stringify(body),
      });
      this.appendMessage(message);
    },

    /** Authenticate with a room server or repeater over the server radio. */
    async loginToNode(contactKey: string, password: string) {
      await api(`/contacts/${contactKey}/login`, {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      this.nodeLogins[contactKey] = true;
    },

    async fetchNodeStatus(contactKey: string): Promise<NodeStats> {
      const { status } = await api<{ status: NodeStats }>(`/contacts/${contactKey}/status`);
      return status;
    },

    async fetchTelemetry(contactKey: string): Promise<SensorReading[]> {
      const { telemetry } = await api<{ telemetry: SensorReading[] }>(`/contacts/${contactKey}/telemetry`);
      return telemetry;
    },

    async saveChannel(idx: number, name: string, secret: string) {
      await api(`/channels/${idx}`, { method: "PUT", body: JSON.stringify({ name, secret }) });
      await this.refreshChannels();
    },

    async deleteChannel(idx: number) {
      await api(`/channels/${idx}`, { method: "DELETE" });
      if (this.activeConversation?.kind === "channel" && this.activeConversation.channelIdx === idx) {
        this.activeConversation = null;
      }
      await this.refreshChannels();
    },

    async sendAdvert(flood: boolean) {
      if (browserSource && this.browserRadio?.state === "connected") {
        await browserSource.sendAdvert(flood);
        return;
      }
      await api("/advert", { method: "POST", body: JSON.stringify({ flood }) });
    },

    /**
     * Hand the radio to this browser: release the server's claim on a same-host
     * radio, then open WebSerial/WebBLE (Chromium device picker).
     */
    async startBrowserRadio(kind: BrowserRadioKind, privateSession: boolean) {
      if (browserSource) await this.stopBrowserRadio(false);
      const serverState = this.status?.connection.state;
      if (serverState === "connected" || serverState === "syncing" || serverState === "connecting") {
        await api("/connection/release", { method: "POST" }).catch(() => {});
        await this.refreshStatus().catch(() => {});
      }
      this.browserRadio = { kind, state: "connecting", error: null, privateSession, batteryMilliVolts: null };
      const source = new BrowserRadioSource(kind, privateSession, {
        onState: (state, error) => {
          if (this.browserRadio) {
            this.browserRadio.state = state;
            this.browserRadio.error = error;
          }
        },
        onLocalMessage: (message) => this.appendMessage(message),
        onLocalStatus: (id, status) => {
          for (const list of Object.values(this.conversations)) {
            const message = list.find((m) => m.id === id);
            if (message) message.status = status;
          }
        },
        onSelf: (self) => {
          if (this.status) this.status.self = self;
        },
        onBattery: (mv) => {
          if (this.browserRadio) this.browserRadio.batteryMilliVolts = mv;
        },
      });
      browserSource = source;
      try {
        await source.start();
      } catch (error) {
        browserSource = null;
        this.browserRadio = null;
        throw error;
      }
      // synced traffic lands in the server DB; refresh what we mirror from it
      if (!privateSession) {
        await Promise.all([this.refreshContacts(), this.refreshStatus()]).catch(() => {});
      }
    },

    /** Stop driving the radio from this browser; optionally hand it back to the server. */
    async stopBrowserRadio(claimServer: boolean) {
      const source = browserSource;
      browserSource = null;
      if (source) await source.stop().catch(() => {});
      this.browserRadio = null;
      if (claimServer) {
        await api("/connection/claim", { method: "POST" }).catch(() => {});
      }
      await this.refreshStatus().catch(() => {});
    },

    appendMessage(message: Message) {
      const id: ConversationId =
        message.kind === "dm"
          ? { kind: "dm", contactKey: message.contactKey ?? "" }
          : { kind: "channel", channelIdx: message.channelIdx ?? 0 };
      const key = conversationKey(id);
      const list = (this.conversations[key] ??= []);
      if (!list.some((m) => m.id === message.id)) {
        list.push(message);
      }
      this.recent = [message, ...this.recent.filter((m) => m.id !== message.id)].slice(0, 50);
      const isActive = this.activeConversation && conversationKey(this.activeConversation) === key;
      if (message.direction === "in" && !isActive) {
        this.unread[key] = (this.unread[key] ?? 0) + 1;
      }
    },

    onEvent(event: WsEvent) {
      switch (event.type) {
        case "status.changed":
          this.status = event.status;
          break;
        case "message.new":
          this.appendMessage(event.message);
          break;
        case "message.status": {
          for (const list of Object.values(this.conversations)) {
            const message = list.find((m) => m.id === event.id);
            if (message) message.status = event.status;
          }
          break;
        }
        case "contact.updated": {
          const index = this.contacts.findIndex((c) => c.publicKey === event.contact.publicKey);
          if (index >= 0) {
            this.contacts[index] = event.contact;
          } else {
            this.contacts.push(event.contact);
          }
          break;
        }
        case "contact.removed": {
          this.contacts = this.contacts.filter((c) => c.publicKey !== event.publicKey);
          const key = `dm:${event.publicKey}`;
          delete this.unread[key];
          if (this.activeConversation?.kind === "dm" && this.activeConversation.contactKey === event.publicKey) {
            this.activeConversation = null;
          }
          break;
        }
        case "self.updated":
          if (this.status) this.status.self = event.self;
          break;
        case "telemetry":
          if (this.status) this.status.batteryMilliVolts = event.batteryMilliVolts;
          break;
      }
    },
  },
});
