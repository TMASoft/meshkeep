<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { Message } from "@meshkeep/shared";
import { useAppStore, conversationKey, type ConversationId } from "../stores/app";

const store = useAppStore();
const draft = ref("");
const sending = ref(false);
const error = ref<string | null>(null);
const thread = ref<HTMLElement | null>(null);

const active = computed(() => store.activeConversation);
const activeKey = computed(() => (active.value ? conversationKey(active.value) : null));
const messages = computed<Message[]>(() => (activeKey.value ? store.conversations[activeKey.value] ?? [] : []));

const activeTitle = computed(() => {
  const id = active.value;
  if (!id) return "";
  if (id.kind === "dm") {
    return store.contacts.find((c) => c.publicKey === id.contactKey)?.name ?? shortKey(id.contactKey);
  }
  return `#${store.channels.find((c) => c.idx === id.channelIdx)?.name ?? id.channelIdx}`;
});

function shortKey(key: string): string {
  return `${key.slice(0, 8)}…`;
}

function formatTime(epoch: number): string {
  return new Date(epoch * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function statusIcon(message: Message): string {
  if (message.direction === "in") return "";
  switch (message.status) {
    case "pending":
      return "⏳";
    case "sent":
      return "✓";
    case "delivered":
      return "✓✓";
    case "failed":
      return "⚠";
  }
}

async function open(id: ConversationId) {
  error.value = null;
  await store.openConversation(id);
  scrollToEnd();
}

async function send() {
  const id = active.value;
  const text = draft.value.trim();
  if (!id || !text || sending.value) return;
  sending.value = true;
  error.value = null;
  try {
    await store.sendMessage(id, text);
    draft.value = "";
  } catch (e) {
    error.value = e instanceof Error ? e.message : "failed to send";
  } finally {
    sending.value = false;
  }
}

function scrollToEnd() {
  void nextTick(() => {
    thread.value?.scrollTo({ top: thread.value.scrollHeight });
  });
}

watch(() => messages.value.length, scrollToEnd);
</script>

<template>
  <div class="flex h-full">
    <aside
      class="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
    >
      <div class="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Channels</div>
      <button
        v-for="channel in store.channels"
        :key="`ch-${channel.idx}`"
        class="flex items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
        :class="{
          'bg-slate-200 dark:bg-slate-800':
            active?.kind === 'channel' && active.channelIdx === channel.idx,
        }"
        @click="open({ kind: 'channel', channelIdx: channel.idx })"
      >
        <span># {{ channel.name }}</span>
        <span
          v-if="store.unread[`ch:${channel.idx}`]"
          class="rounded-full bg-emerald-500 px-1.5 text-xs font-medium text-white"
        >
          {{ store.unread[`ch:${channel.idx}`] }}
        </span>
      </button>

      <div class="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-slate-400">Contacts</div>
      <button
        v-for="contact in store.contacts"
        :key="contact.publicKey"
        class="flex items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
        :class="{
          'bg-slate-200 dark:bg-slate-800': active?.kind === 'dm' && active.contactKey === contact.publicKey,
        }"
        @click="open({ kind: 'dm', contactKey: contact.publicKey })"
      >
        <span class="flex min-w-0 items-center gap-1.5">
          <span>{{ contact.type === "repeater" ? "📡" : contact.type === "room" ? "🏠" : "👤" }}</span>
          <span class="truncate">{{ contact.name || shortKey(contact.publicKey) }}</span>
        </span>
        <span
          v-if="store.unread[`dm:${contact.publicKey}`]"
          class="rounded-full bg-emerald-500 px-1.5 text-xs font-medium text-white"
        >
          {{ store.unread[`dm:${contact.publicKey}`] }}
        </span>
      </button>
      <p v-if="!store.contacts.length" class="px-3 py-2 text-sm text-slate-400">
        No contacts yet — send an advert from the Device page.
      </p>
    </aside>

    <section class="flex min-w-0 flex-1 flex-col">
      <template v-if="active">
        <div class="border-b border-slate-200 bg-white px-4 py-2 font-medium dark:border-slate-800 dark:bg-slate-900">
          {{ activeTitle }}
        </div>
        <div ref="thread" class="flex-1 space-y-2 overflow-y-auto p-4">
          <div
            v-for="message in messages"
            :key="message.id"
            class="flex"
            :class="message.direction === 'out' ? 'justify-end' : 'justify-start'"
          >
            <div
              class="max-w-[70%] rounded-2xl px-3 py-2 text-sm shadow-sm"
              :class="
                message.direction === 'out'
                  ? 'rounded-br-sm bg-emerald-600 text-white'
                  : 'rounded-bl-sm bg-white dark:bg-slate-800'
              "
            >
              <div
                v-if="message.kind === 'channel' && message.direction === 'in'"
                class="text-xs font-medium opacity-70"
              >
                {{ message.contactName ?? "unknown sender" }}
              </div>
              <div class="whitespace-pre-wrap break-words">{{ message.text }}</div>
              <div class="mt-0.5 text-right text-[11px] opacity-60">
                {{ formatTime(message.senderTimestamp) }} {{ statusIcon(message) }}
              </div>
            </div>
          </div>
          <p v-if="!messages.length" class="pt-8 text-center text-sm text-slate-400">No messages yet.</p>
        </div>
        <form
          class="flex gap-2 border-t border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900"
          @submit.prevent="send"
        >
          <input
            v-model="draft"
            type="text"
            :placeholder="`Message ${activeTitle}`"
            maxlength="2000"
            class="flex-1 rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-emerald-500 dark:border-slate-700"
          />
          <button
            type="submit"
            :disabled="sending || !draft.trim()"
            class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            Send
          </button>
        </form>
        <p v-if="error" class="bg-rose-50 px-4 py-1.5 text-sm text-rose-600 dark:bg-rose-950">{{ error }}</p>
      </template>
      <div v-else class="flex flex-1 items-center justify-center text-slate-400">
        Pick a channel or contact to start chatting.
      </div>
    </section>
  </div>
</template>
