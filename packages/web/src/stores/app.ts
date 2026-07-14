import { defineStore } from "pinia";
import type { AppStatus, Channel, Contact, Message, WsEvent } from "@meshkeep/shared";
import { api, connectEvents, type WsStatus } from "../api/client";

export type ConversationId = { kind: "dm"; contactKey: string } | { kind: "channel"; channelIdx: number };

export function conversationKey(id: ConversationId): string {
  return id.kind === "dm" ? `dm:${id.contactKey}` : `ch:${id.channelIdx}`;
}

export const useAppStore = defineStore("app", {
  state: () => ({
    status: null as AppStatus | null,
    wsStatus: "connecting" as WsStatus,
    contacts: [] as Contact[],
    channels: [] as Channel[],
    // messages per conversation key, ascending by id
    conversations: {} as Record<string, Message[]>,
    recent: [] as Message[],
    activeConversation: null as ConversationId | null,
    unread: {} as Record<string, number>,
    loaded: false,
    stopEvents: null as null | (() => void),
  }),

  getters: {
    connectionState: (state) => state.status?.connection.state ?? "disconnected",
    self: (state) => state.status?.self ?? null,
    batteryPercent: (state): number | null => {
      const mv = state.status?.batteryMilliVolts;
      if (!mv) return null;
      // rough LiPo curve: 3.3V empty → 4.2V full
      return Math.max(0, Math.min(100, Math.round(((mv - 3300) / 900) * 100)));
    },
    chatContacts: (state) => state.contacts.filter((c) => c.type === "chat"),
  },

  actions: {
    async bootstrap() {
      if (this.loaded) return;
      await Promise.all([this.refreshStatus(), this.refreshContacts(), this.refreshChannels()]);
      this.stopEvents = connectEvents(
        (event) => this.onEvent(event),
        (status) => {
          this.wsStatus = status;
        },
      );
      this.loaded = true;
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
      this.conversations[key] = messages;
      this.unread[key] = 0;
      void api("/messages/read", {
        method: "POST",
        body: JSON.stringify(id.kind === "dm" ? { contact: id.contactKey } : { channel: id.channelIdx }),
      }).catch(() => {});
    },

    async sendMessage(id: ConversationId, text: string) {
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
