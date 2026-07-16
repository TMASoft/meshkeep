import { defineStore } from "pinia";
import type {
  AppStatus,
  Channel,
  ConnectionState,
  Contact,
  Message,
  MessageSearchResult,
  NodeStats,
  SensorReading,
  WsEvent,
} from "@meshkeep/shared";
import { api, ApiError, connectEvents, type WsStatus } from "../api/client";
import { BrowserRadioSource, type BrowserRadioKind } from "../sources/browser-radio";
import { notifyIncoming } from "../notifications";

// lives outside the store: holds a live connection object, must not be reactive
let browserSource: BrowserRadioSource | null = null;

export type ConversationId =
  | { kind: "dm"; contactKey: string; contactPrefix?: undefined }
  | { kind: "dm"; contactKey?: undefined; contactPrefix: string }
  | { kind: "channel"; channelIdx: number };

export function conversationKey(id: ConversationId): string {
  return id.kind === "dm" ? `dm:${id.contactKey ?? `unknown:${id.contactPrefix}`}` : `ch:${id.channelIdx}`;
}

function conversationForMessage(message: Message): ConversationId {
  if (message.kind === "channel") return { kind: "channel", channelIdx: message.channelIdx ?? 0 };
  return message.contactKey
    ? { kind: "dm", contactKey: message.contactKey }
    : { kind: "dm", contactPrefix: message.contactPrefix ?? "" };
}

function dmQuery(id: Extract<ConversationId, { kind: "dm" }>): string {
  return id.contactKey ? `contact=${encodeURIComponent(id.contactKey)}` : `sender=${encodeURIComponent(id.contactPrefix ?? "")}`;
}

function finalStatus(current: Message["status"], next: Message["status"]): Message["status"] {
  return current === "delivered" || current === "failed" ? current : next;
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
    unknownSenders: [] as Message[],
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
      await Promise.all([this.refreshStatus(), this.refreshContacts(), this.refreshChannels(), this.refreshUnknownSenders()]);
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
      this.reconcileUnknownConversations();
    },

    async refreshUnknownSenders() {
      const { messages } = await api<{ messages: Message[] }>("/messages/unknown-senders");
      this.unknownSenders = messages;
    },

    async refreshChannels() {
      const { channels } = await api<{ channels: Channel[] }>("/channels");
      this.channels = channels;
    },

    async openConversation(id: ConversationId) {
      this.activeConversation = id;
      const key = conversationKey(id);
      const query = id.kind === "dm" ? dmQuery(id) : `channel=${id.channelIdx}`;
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
        body: JSON.stringify(id.kind === "dm" ? (id.contactKey ? { contact: id.contactKey } : { sender: id.contactPrefix }) : { channel: id.channelIdx }),
      }).catch(() => {});
    },

    async searchMessages(query: string): Promise<MessageSearchResult[]> {
      const { results } = await api<{ results: MessageSearchResult[] }>(
        `/messages/search?q=${encodeURIComponent(query)}&limit=20`,
      );
      return results;
    },

    /**
     * Open a conversation and page history backwards until the given message
     * is in the loaded window (bounded). Returns whether it was found.
     */
    async openConversationAt(id: ConversationId, messageId: number): Promise<boolean> {
      await this.openConversation(id);
      const key = conversationKey(id);
      const query = id.kind === "dm" ? dmQuery(id) : `channel=${id.channelIdx}`;
      for (let page = 0; page < 25; page++) {
        const list = this.conversations[key] ?? [];
        if (list.some((message) => message.id === messageId)) return true;
        const oldest = list[0]?.id;
        if (oldest === undefined || oldest <= messageId) return false;
        const { messages } = await api<{ messages: Message[] }>(`/messages?${query}&before=${oldest}&limit=200`);
        if (!messages.length) return false;
        const merged = new Map(messages.map((message) => [message.id, message]));
        for (const message of list) merged.set(message.id, message);
        this.conversations[key] = [...merged.values()].sort((a, b) => a.id - b.id);
      }
      return false;
    },

    async sendMessage(id: ConversationId, text: string) {
      if (id.kind === "dm" && !id.contactKey) {
        throw new Error("Cannot reply until this sender's full public key is known");
      }
      // messages to repeaters are CLI commands, like the official app's remote console
      const cli = id.kind === "dm" && this.contacts.find((c) => c.publicKey === id.contactKey)?.type === "repeater";
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
      * radio and confirm standby before opening WebSerial/WebBLE (Chromium device picker).
      */
    async startBrowserRadio(kind: BrowserRadioKind, privateSession: boolean) {
      if (browserSource) await this.stopBrowserRadio(false);
      const reclaimServer = async () => {
        await api("/connection/claim", { method: "POST" });
        await this.refreshStatus().catch(() => {});
      };
      try {
        const release = await api<{ ok: boolean; state: ConnectionState }>("/connection/release", { method: "POST" });
        if (release.state !== "standby") {
          throw new Error("Server did not enter standby before browser radio startup");
        }
      } catch (error) {
        try {
          await reclaimServer();
        } catch (claimError) {
          const detail = claimError instanceof Error ? claimError.message : "unknown error";
          throw new Error(`Server ownership could not be confirmed or restored: ${detail}`);
        }
        throw error;
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
          this.updateMessageStatus(id, status);
        },
        onSyncedMessage: (message) => this.appendMessage(message),
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
        try {
          await reclaimServer();
        } catch (claimError) {
          const detail = claimError instanceof Error ? claimError.message : "unknown error";
          throw new Error(`Browser radio startup failed and server ownership could not be restored: ${detail}`);
        }
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
      const id = conversationForMessage(message);
      const key = conversationKey(id);
      const list = (this.conversations[key] ??= []);
      const prior = this.findMessage(message);
      if (prior && prior.message.id !== message.id) {
        prior.list.splice(prior.index, 1);
        const merged = { ...prior.message, ...message, status: finalStatus(prior.message.status, message.status) };
        list.push(merged);
        this.recent = [merged, ...this.recent.filter((m) => m.id !== prior.message.id && m.id !== message.id)].slice(0, 50);
        return;
      }
      if (prior) {
        const merged = { ...prior.message, ...message, status: finalStatus(prior.message.status, message.status) };
        prior.list[prior.index] = merged;
        this.recent = [merged, ...this.recent.filter((m) => m.id !== message.id)].slice(0, 50);
        return;
      }
      list.push(message);
      this.recent = [message, ...this.recent.filter((m) => m.id !== message.id)].slice(0, 50);
      if (message.kind === "dm" && !message.contactKey && message.contactPrefix) {
        this.unknownSenders = [message, ...this.unknownSenders.filter((m) => m.contactPrefix !== message.contactPrefix)];
      }
      const isActive = this.activeConversation && conversationKey(this.activeConversation) === key;
      if (message.direction === "in" && !isActive) {
        this.unread[key] = (this.unread[key] ?? 0) + 1;
      }
      if (message.direction === "in") {
        notifyIncoming(message, { conversationActive: Boolean(isActive) });
      }
    },

    updateMessageStatus(id: number, status: Message["status"]) {
      for (const list of Object.values(this.conversations)) {
        const message = list.find((m) => m.id === id);
        if (message) message.status = finalStatus(message.status, status);
      }
      this.recent = this.recent.map((message) =>
        message.id === id ? { ...message, status: finalStatus(message.status, status) } : message,
      );
    },

    findMessage(message: Message): { list: Message[]; index: number; message: Message } | null {
      for (const list of Object.values(this.conversations)) {
        const index = list.findIndex(
          (existing) =>
            existing.id === message.id ||
            (message.ingestionId !== undefined && message.ingestionId !== null && existing.ingestionId === message.ingestionId),
        );
        if (index >= 0) return { list, index, message: list[index]! };
      }
      return null;
    },

    reconcileUnknownConversations() {
      for (const unknown of [...this.unknownSenders]) {
        const prefix = unknown.contactPrefix;
        if (!prefix) continue;
        const matches = this.contacts.filter((contact) => contact.publicKey.startsWith(prefix));
        if (matches.length !== 1) continue;
        const contact = matches[0]!;
        const oldId: ConversationId = { kind: "dm", contactPrefix: prefix };
        const newId: ConversationId = { kind: "dm", contactKey: contact.publicKey };
        const oldKey = conversationKey(oldId);
        const newKey = conversationKey(newId);
        const moved = (this.conversations[oldKey] ?? []).map((message) => ({ ...message, contactKey: contact.publicKey }));
        if (moved.length) {
          const merged = new Map((this.conversations[newKey] ?? []).map((message) => [message.id, message]));
          for (const message of moved) merged.set(message.id, message);
          this.conversations[newKey] = [...merged.values()].sort((a, b) => a.id - b.id);
          delete this.conversations[oldKey];
        }
        if (this.unread[oldKey]) {
          this.unread[newKey] = (this.unread[newKey] ?? 0) + this.unread[oldKey];
          delete this.unread[oldKey];
        }
        if (this.activeConversation && conversationKey(this.activeConversation) === oldKey) this.activeConversation = newId;
        this.recent = this.recent.map((message) =>
          message.contactPrefix === prefix && !message.contactKey ? { ...message, contactKey: contact.publicKey } : message,
        );
        this.unknownSenders = this.unknownSenders.filter((message) => message.contactPrefix !== prefix);
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
          this.updateMessageStatus(event.id, event.status);
          break;
        }
        case "contact.updated": {
          const index = this.contacts.findIndex((c) => c.publicKey === event.contact.publicKey);
          if (index >= 0) {
            this.contacts[index] = event.contact;
          } else {
            this.contacts.push(event.contact);
          }
          this.reconcileUnknownConversations();
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
