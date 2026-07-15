<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { Contact, Message, NodeStats, SensorReading } from "@meshkeep/shared";
import { api } from "../api/client";
import { useAppStore, conversationKey, type ConversationId } from "../stores/app";
import AppIcon from "../components/AppIcon.vue";

const store = useAppStore();
const draft = ref("");
const sending = ref(false);
const opening = ref(false);
const error = ref<string | null>(null);
const thread = ref<HTMLElement | null>(null);
const search = ref("");
const lastConversationButton = ref<HTMLButtonElement | null>(null);
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const active = computed(() => store.activeConversation);
const activeKey = computed(() => (active.value ? conversationKey(active.value) : null));
const messages = computed<Message[]>(() => (activeKey.value ? store.conversations[activeKey.value] ?? [] : []));
const filteredContacts = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  if (!query) return store.contacts;
  return store.contacts.filter(
    (contact) => contact.name?.toLocaleLowerCase().includes(query) || contact.publicKey.toLocaleLowerCase().includes(query),
  );
});
const totalUnread = computed(() => Object.values(store.unread).reduce((total, count) => total + count, 0));

const activeTitle = computed(() => {
  const id = active.value;
  if (!id) return "";
  if (id.kind === "dm") {
    return store.contacts.find((contact) => contact.publicKey === id.contactKey)?.name ?? shortKey(id.contactKey);
  }
  return `#${store.channels.find((channel) => channel.idx === id.channelIdx)?.name ?? id.channelIdx}`;
});

const activeMeta = computed(() => {
  const id = active.value;
  if (!id) return "";
  if (id.kind === "channel") return `Shared channel ${id.channelIdx}`;
  const contact = store.contacts.find((item) => item.publicKey === id.contactKey);
  return contact ? `${contact.type} node · ${shortKey(contact.publicKey)}` : shortKey(id.contactKey);
});

function shortKey(key: string): string {
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

function formatTime(epoch: number): string {
  return new Date(epoch * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function contactIcon(contact: Contact): "repeater" | "room" | "user" {
  if (contact.type === "repeater") return "repeater";
  if (contact.type === "room") return "room";
  return "user";
}

function statusLabel(message: Message): string {
  if (message.direction === "in") return "";
  switch (message.status) {
    case "pending":
      return "Pending";
    case "sent":
      return "Sent";
    case "delivered":
      return "Delivered";
    case "failed":
      return "Failed";
  }
}

async function open(id: ConversationId, event?: Event) {
  if (opening.value) return;
  if (event?.currentTarget instanceof HTMLButtonElement) lastConversationButton.value = event.currentTarget;
  error.value = null;
  opening.value = true;
  try {
    await store.openConversation(id);
    scrollToEnd();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Failed to open conversation";
  } finally {
    opening.value = false;
  }
}

function closeMobileThread() {
  store.activeConversation = null;
  error.value = null;
  void nextTick(() => lastConversationButton.value?.focus());
}

async function send() {
  const id = active.value;
  const text = draft.value.trim();
  if (!id || !text || sending.value || opening.value) return;
  sending.value = true;
  error.value = null;
  try {
    await store.sendMessage(id, text);
    draft.value = "";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Failed to send";
  } finally {
    sending.value = false;
  }
}

function scrollToEnd() {
  void nextTick(() => {
    thread.value?.scrollTo({ top: thread.value.scrollHeight, behavior: reduceMotion.matches ? "auto" : "smooth" });
  });
}

watch(() => messages.value.length, scrollToEnd);

// ---- conversation details & contact management ----

const detailsOpen = ref(false);
const detailsBusy = ref<string | null>(null);
const detailsNotice = ref<string | null>(null);

watch(active, () => {
  detailsOpen.value = false;
  detailsNotice.value = null;
});

const activeContact = computed<Contact | null>(() => {
  const id = active.value;
  if (!id || id.kind !== "dm") return null;
  return store.contacts.find((contact) => contact.publicKey === id.contactKey) ?? null;
});

const exportHref = computed(() => {
  const id = active.value;
  if (!id) return "#";
  return id.kind === "dm"
    ? `/api/v1/messages/export?format=csv&contact=${id.contactKey}`
    : `/api/v1/messages/export?format=csv&channel=${id.channelIdx}`;
});

async function detailsAction(label: string, fn: () => Promise<void>) {
  detailsBusy.value = label;
  detailsNotice.value = null;
  error.value = null;
  try {
    await fn();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : `${label} failed`;
  } finally {
    detailsBusy.value = null;
  }
}

const copyContactUri = () =>
  detailsAction("share", async () => {
    const contact = activeContact.value;
    if (!contact) return;
    const { uri } = await api<{ uri: string }>(`/contacts/${contact.publicKey}/export`);
    await navigator.clipboard.writeText(uri);
    detailsNotice.value = "meshcore:// link copied";
  });

const resetContactPath = () =>
  detailsAction("path", async () => {
    const contact = activeContact.value;
    if (!contact) return;
    await api(`/contacts/${contact.publicKey}/path-reset`, { method: "POST" });
    detailsNotice.value = "Route reset — next message will flood";
  });

const removeActiveContact = () =>
  detailsAction("remove", async () => {
    const contact = activeContact.value;
    if (!contact) return;
    if (!window.confirm(`Remove ${contact.name || "this node"} from the radio's contacts? Message history is kept.`)) {
      return;
    }
    await api(`/contacts/${contact.publicKey}`, { method: "DELETE" });
    // the contact.removed event also arrives over the WebSocket; update eagerly
    store.contacts = store.contacts.filter((c) => c.publicKey !== contact.publicKey);
    store.activeConversation = null;
  });

// ---- contact import ----

const importOpen = ref(false);
const importUri = ref("");
const importBusy = ref(false);
const importError = ref<string | null>(null);

async function submitImport() {
  const uri = importUri.value.trim();
  if (!uri || importBusy.value) return;
  importBusy.value = true;
  importError.value = null;
  try {
    await api("/contacts/import", { method: "POST", body: JSON.stringify({ uri }) });
    await store.refreshContacts();
    importUri.value = "";
    importOpen.value = false;
  } catch (cause) {
    importError.value = cause instanceof Error ? cause.message : "Import failed";
  } finally {
    importBusy.value = false;
  }
}

// ---- channel create / edit ----

const channelFormOpen = ref(false);
const channelSlot = ref(0);
const channelName = ref("");
const channelSecret = ref("");
const channelBusy = ref(false);
const channelError = ref<string | null>(null);

const slotOptions = computed(() =>
  Array.from({ length: 8 }, (_, idx) => ({
    idx,
    label: store.channels.find((c) => c.idx === idx)
      ? `${idx} — replaces #${store.channels.find((c) => c.idx === idx)!.name}`
      : `${idx} — empty`,
  })),
);

function generateSecret(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function openChannelForm(channel?: { idx: number; name: string; secret: string }) {
  channelError.value = null;
  if (channel) {
    channelSlot.value = channel.idx;
    channelName.value = channel.name;
    channelSecret.value = channel.secret;
  } else {
    const free = Array.from({ length: 8 }, (_, idx) => idx).find(
      (idx) => !store.channels.some((c) => c.idx === idx),
    );
    channelSlot.value = free ?? 0;
    channelName.value = "";
    channelSecret.value = generateSecret();
  }
  channelFormOpen.value = true;
}

async function submitChannel() {
  const name = channelName.value.trim();
  const secret = channelSecret.value.trim().toLowerCase();
  channelError.value = null;
  if (!name) {
    channelError.value = "Channel name is required";
    return;
  }
  if (!/^[0-9a-f]{32}$/.test(secret)) {
    channelError.value = "Secret must be 32 hex characters (16 bytes) — use Generate, or paste a shared key";
    return;
  }
  channelBusy.value = true;
  try {
    await store.saveChannel(channelSlot.value, name, secret);
    channelFormOpen.value = false;
    await open({ kind: "channel", channelIdx: channelSlot.value });
  } catch (cause) {
    channelError.value = cause instanceof Error ? cause.message : "Failed to save channel";
  } finally {
    channelBusy.value = false;
  }
}

const activeChannel = computed(() => {
  const id = active.value;
  if (!id || id.kind !== "channel") return null;
  return store.channels.find((channel) => channel.idx === id.channelIdx) ?? null;
});

// ---- room server / repeater sessions ----

const isRemoteNode = computed(
  () => activeContact.value?.type === "repeater" || activeContact.value?.type === "room",
);
const isLoggedIn = computed(
  () => !!activeContact.value && !!store.nodeLogins[activeContact.value.publicKey],
);
const loginPassword = ref("");
const nodeStatus = ref<NodeStats | null>(null);
const sensorReadings = ref<SensorReading[] | null>(null);

watch(active, () => {
  loginPassword.value = "";
  nodeStatus.value = null;
  sensorReadings.value = null;
});

const loginToNode = () =>
  detailsAction("login", async () => {
    const contact = activeContact.value;
    if (!contact || !loginPassword.value) return;
    await store.loginToNode(contact.publicKey, loginPassword.value);
    loginPassword.value = "";
    detailsNotice.value = "Authenticated";
  });

const requestStatus = () =>
  detailsAction("status", async () => {
    const contact = activeContact.value;
    if (!contact) return;
    nodeStatus.value = await store.fetchNodeStatus(contact.publicKey);
  });

const requestTelemetry = () =>
  detailsAction("telemetry", async () => {
    const contact = activeContact.value;
    if (!contact) return;
    sensorReadings.value = await store.fetchTelemetry(contact.publicKey);
    if (!sensorReadings.value.length) detailsNotice.value = "Node replied but reported no sensor data";
  });

function fmtReading(reading: SensorReading): string {
  if (typeof reading.value === "number") {
    return `${reading.value}${reading.unit ? ` ${reading.unit}` : ""}`;
  }
  return Object.entries(reading.value)
    .map(([key, value]) => `${key} ${value}`)
    .join(", ");
}

const deleteActiveChannel = () =>
  detailsAction("delete", async () => {
    const channel = activeChannel.value;
    if (!channel) return;
    if (!window.confirm(`Delete #${channel.name}? The slot is blanked on the radio; message history is kept.`)) {
      return;
    }
    await store.deleteChannel(channel.idx);
  });

async function copyChannelSecret() {
  const channel = activeChannel.value;
  if (!channel) return;
  try {
    await navigator.clipboard.writeText(channel.secret);
    detailsNotice.value = "Channel secret copied — share it with people joining";
  } catch {
    detailsNotice.value = null;
  }
}

function fmtUptime(secs: number): string {
  const days = Math.floor(secs / 86_400);
  const hours = Math.floor((secs % 86_400) / 3600);
  const minutes = Math.floor((secs % 3600) / 60);
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

const composerPlaceholder = computed(() => {
  if (activeContact.value?.type === "repeater") {
    return isLoggedIn.value ? `CLI command for ${activeTitle.value}` : "CLI command (log in via ⓘ first)";
  }
  return `Message ${activeTitle.value}`;
});

function fmtLastAdvert(epoch: number): string {
  if (!epoch) return "never";
  const minutes = Math.floor((Date.now() / 1000 - epoch) / 60);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 48) return `${Math.floor(minutes / 60)} h ago`;
  return new Date(epoch * 1000).toLocaleDateString();
}
</script>

<template>
  <div class="comms-layout" :class="{ 'thread-is-open': active }">
    <aside class="conversation-panel" aria-label="Conversations">
      <div class="conversation-heading">
        <div>
          <span class="instrument-label">Mesh traffic</span>
          <h1>Comms</h1>
        </div>
        <span v-if="totalUnread" class="total-unread">{{ totalUnread }} new</span>
      </div>

      <label class="search-field">
        <AppIcon name="search" :size="17" />
        <span class="sr-only">Filter contacts</span>
        <input v-model="search" type="search" placeholder="Find a node" autocomplete="off" />
      </label>

      <div class="conversation-scroll">
        <section class="conversation-group" aria-labelledby="channels-heading">
          <div class="group-heading">
            <h2 id="channels-heading">Channels</h2>
            <span class="group-heading-tools">
              <button
                class="group-add"
                type="button"
                aria-label="Create or join a channel"
                :aria-expanded="channelFormOpen"
                @click="channelFormOpen ? (channelFormOpen = false) : openChannelForm()"
              >
                <AppIcon name="plus" :size="14" />
              </button>
              {{ store.channels.length.toString().padStart(2, "0") }}
            </span>
          </div>
          <form v-if="channelFormOpen" class="channel-form" @submit.prevent="submitChannel">
            <label>
              <span>Slot</span>
              <select v-model.number="channelSlot">
                <option v-for="slot in slotOptions" :key="slot.idx" :value="slot.idx">{{ slot.label }}</option>
              </select>
            </label>
            <label>
              <span>Name</span>
              <input v-model="channelName" maxlength="31" placeholder="my-channel" autocomplete="off" />
            </label>
            <label>
              <span>Shared secret · paste to join, generate to create</span>
              <div class="secret-row">
                <input v-model="channelSecret" placeholder="32 hex characters" spellcheck="false" autocomplete="off" />
                <button type="button" @click="channelSecret = generateSecret()">Generate</button>
              </div>
            </label>
            <p v-if="channelError" class="import-error" role="alert">{{ channelError }}</p>
            <button class="import-submit channel-submit" type="submit" :disabled="channelBusy">
              {{ channelBusy ? "Saving" : "Save channel" }}
            </button>
          </form>
          <button
            v-for="channel in store.channels"
            :key="`ch-${channel.idx}`"
            class="conversation-row"
            :class="{ active: active?.kind === 'channel' && active.channelIdx === channel.idx }"
            type="button"
            :disabled="opening"
            :aria-current="active?.kind === 'channel' && active.channelIdx === channel.idx ? 'true' : undefined"
            @click="open({ kind: 'channel', channelIdx: channel.idx }, $event)"
          >
            <span class="conversation-avatar channel-avatar"><AppIcon name="channel" :size="18" /></span>
            <span class="conversation-copy">
              <strong>#{{ channel.name }}</strong>
              <small>Channel {{ channel.idx }}</small>
            </span>
            <span v-if="store.unread[`ch:${channel.idx}`]" class="unread-badge">
              {{ store.unread[`ch:${channel.idx}`] }}
            </span>
          </button>
          <p v-if="!store.channels.length" class="group-empty">No configured channels</p>
        </section>

        <section class="conversation-group" aria-labelledby="contacts-heading">
          <div class="group-heading">
            <h2 id="contacts-heading">Contacts</h2>
            <span class="group-heading-tools">
              <button
                class="group-add"
                type="button"
                aria-label="Import a contact from a meshcore:// link"
                :aria-expanded="importOpen"
                @click="importOpen = !importOpen"
              >
                <AppIcon name="plus" :size="14" />
              </button>
              {{ filteredContacts.length.toString().padStart(2, "0") }}
            </span>
          </div>
          <form v-if="importOpen" class="import-form" @submit.prevent="submitImport">
            <label>
              <span class="sr-only">meshcore:// contact link</span>
              <input
                v-model="importUri"
                placeholder="meshcore://…"
                autocomplete="off"
                spellcheck="false"
              />
            </label>
            <button class="import-submit" type="submit" :disabled="importBusy || !importUri.trim()">
              {{ importBusy ? "Importing" : "Import" }}
            </button>
            <p v-if="importError" class="import-error" role="alert">{{ importError }}</p>
          </form>
          <button
            v-for="contact in filteredContacts"
            :key="contact.publicKey"
            class="conversation-row"
            :class="{ active: active?.kind === 'dm' && active.contactKey === contact.publicKey }"
            type="button"
            :disabled="opening"
            :aria-current="active?.kind === 'dm' && active.contactKey === contact.publicKey ? 'true' : undefined"
            @click="open({ kind: 'dm', contactKey: contact.publicKey }, $event)"
          >
            <span class="conversation-avatar"><AppIcon :name="contactIcon(contact)" :size="18" /></span>
            <span class="conversation-copy">
              <strong>{{ contact.name || shortKey(contact.publicKey) }}</strong>
              <small>{{ contact.type }} node</small>
            </span>
            <span v-if="store.unread[`dm:${contact.publicKey}`]" class="unread-badge">
              {{ store.unread[`dm:${contact.publicKey}`] }}
            </span>
          </button>
          <p v-if="!store.contacts.length" class="group-empty">
            Send an advert from Radio to discover nearby nodes.
          </p>
          <p v-else-if="!filteredContacts.length" class="group-empty">No matching nodes</p>
        </section>
      </div>
    </aside>

    <section class="thread-panel" aria-label="Message thread">
      <template v-if="active">
        <header class="thread-heading">
          <button class="mobile-back" type="button" aria-label="Back to conversations" @click="closeMobileThread">
            <AppIcon name="back" :size="21" />
          </button>
          <span class="thread-avatar">
            <AppIcon :name="active.kind === 'channel' ? 'channel' : 'user'" :size="20" />
          </span>
          <div class="thread-title">
            <h2>{{ activeTitle }}</h2>
            <p>{{ activeMeta }}</p>
          </div>
          <span class="secure-indicator"><span /> MeshCore</span>
          <button
            class="details-toggle"
            type="button"
            aria-label="Conversation details"
            :aria-expanded="detailsOpen"
            @click="detailsOpen = !detailsOpen"
          >
            <AppIcon name="info" :size="19" />
          </button>
        </header>

        <section v-if="detailsOpen" class="details-panel" aria-label="Conversation details">
          <dl v-if="activeContact" class="details-facts">
            <div><dt>Public key</dt><dd>{{ shortKey(activeContact.publicKey) }}</dd></div>
            <div><dt>Type</dt><dd>{{ activeContact.type }}</dd></div>
            <div><dt>Last advert</dt><dd>{{ fmtLastAdvert(activeContact.lastAdvert) }}</dd></div>
            <div>
              <dt>Route</dt>
              <dd>{{ activeContact.outPathLen < 0 ? "flood" : `${activeContact.outPathLen} hop path` }}</dd>
            </div>
            <div v-if="activeContact.lat !== null">
              <dt>Position</dt>
              <dd>{{ activeContact.lat?.toFixed(4) }}, {{ activeContact.lon?.toFixed(4) }}</dd>
            </div>
          </dl>
          <dl v-else-if="active?.kind === 'channel'" class="details-facts">
            <div><dt>Channel slot</dt><dd>{{ active.channelIdx }}</dd></div>
            <div><dt>Messages</dt><dd>{{ messages.length }} loaded</dd></div>
            <div v-if="activeChannel">
              <dt>Shared secret</dt>
              <dd class="secret-value">{{ activeChannel.secret.slice(0, 8) }}…{{ activeChannel.secret.slice(-4) }}</dd>
            </div>
          </dl>

          <form
            v-if="isRemoteNode && !isLoggedIn"
            class="node-login"
            @submit.prevent="loginToNode"
          >
            <span class="instrument-label">{{ activeContact?.type }} access</span>
            <div class="node-login-row">
              <input
                v-model="loginPassword"
                type="password"
                :placeholder="activeContact?.type === 'room' ? 'Room password' : 'Admin password'"
                autocomplete="off"
              />
              <button type="submit" :disabled="detailsBusy !== null || !loginPassword">
                {{ detailsBusy === "login" ? "Logging in" : "Log in" }}
              </button>
            </div>
          </form>

          <dl v-if="nodeStatus" class="details-facts node-stats">
            <div><dt>Battery</dt><dd>{{ (nodeStatus.battMilliVolts / 1000).toFixed(2) }} V</dd></div>
            <div><dt>Uptime</dt><dd>{{ fmtUptime(nodeStatus.totalUpTimeSecs) }}</dd></div>
            <div><dt>Noise floor</dt><dd>{{ nodeStatus.noiseFloor }} dBm</dd></div>
            <div><dt>Last RSSI / SNR</dt><dd>{{ nodeStatus.lastRssi }} / {{ nodeStatus.lastSnr }}</dd></div>
            <div><dt>Packets rx / tx</dt><dd>{{ nodeStatus.nPacketsRecv }} / {{ nodeStatus.nPacketsSent }}</dd></div>
            <div><dt>Air time</dt><dd>{{ fmtUptime(nodeStatus.totalAirTimeSecs) }}</dd></div>
            <div><dt>Dups d / f</dt><dd>{{ nodeStatus.nDirectDups }} / {{ nodeStatus.nFloodDups }}</dd></div>
            <div><dt>Errors</dt><dd>{{ nodeStatus.errEvents }}</dd></div>
          </dl>

          <dl v-if="sensorReadings?.length" class="details-facts node-stats">
            <div v-for="reading in sensorReadings" :key="`${reading.channel}-${reading.type}`">
              <dt>{{ reading.label }} · ch {{ reading.channel }}</dt>
              <dd>{{ fmtReading(reading) }}</dd>
            </div>
          </dl>

          <p v-if="detailsNotice" class="details-notice" role="status">{{ detailsNotice }}</p>
          <div class="details-actions">
            <template v-if="activeContact">
              <button
                v-if="isRemoteNode"
                type="button"
                :disabled="detailsBusy !== null"
                @click="requestStatus"
              >
                <AppIcon name="signal" :size="15" /> {{ detailsBusy === "status" ? "Requesting" : "Request status" }}
              </button>
              <button type="button" :disabled="detailsBusy !== null" @click="requestTelemetry">
                <AppIcon name="battery" :size="15" /> {{ detailsBusy === "telemetry" ? "Requesting" : "Request telemetry" }}
              </button>
              <button type="button" :disabled="detailsBusy !== null" @click="copyContactUri">
                <AppIcon name="link" :size="15" /> {{ detailsBusy === "share" ? "Copying" : "Copy share link" }}
              </button>
              <button type="button" :disabled="detailsBusy !== null" @click="resetContactPath">
                <AppIcon name="broadcast" :size="15" /> {{ detailsBusy === "path" ? "Resetting" : "Reset route" }}
              </button>
            </template>
            <template v-if="activeChannel">
              <button type="button" @click="copyChannelSecret">
                <AppIcon name="key" :size="15" /> Copy secret
              </button>
              <button type="button" @click="openChannelForm(activeChannel)">
                <AppIcon name="settings" :size="15" /> Edit channel
              </button>
            </template>
            <a :href="exportHref" download>
              <AppIcon name="download" :size="15" /> Export CSV
            </a>
            <button
              v-if="activeContact"
              class="danger"
              type="button"
              :disabled="detailsBusy !== null"
              @click="removeActiveContact"
            >
              <AppIcon name="trash" :size="15" /> {{ detailsBusy === "remove" ? "Removing" : "Remove contact" }}
            </button>
            <button
              v-if="activeChannel"
              class="danger"
              type="button"
              :disabled="detailsBusy !== null"
              @click="deleteActiveChannel"
            >
              <AppIcon name="trash" :size="15" /> {{ detailsBusy === "delete" ? "Deleting" : "Delete channel" }}
            </button>
          </div>
        </section>

        <div ref="thread" class="message-thread" aria-live="polite" :aria-busy="opening">
          <div v-if="opening" class="thread-state">
            <span class="loading-mark" />
            <p>Loading traffic</p>
          </div>
          <div v-else-if="!messages.length" class="thread-state">
            <span class="empty-signal"><AppIcon name="signal" :size="28" /></span>
            <h3>Channel clear</h3>
            <p>No messages in this conversation yet.</p>
          </div>
          <div
            v-for="message in messages"
            v-else
            :key="message.id"
            class="message-row"
            :class="message.direction"
          >
            <article class="message-bubble">
              <p v-if="message.kind === 'channel' && message.direction === 'in'" class="message-sender">
                {{ message.contactName ?? "Unknown sender" }}
              </p>
              <p v-else-if="message.authorPrefix" class="message-sender">
                {{ message.authorName ?? shortKey(message.authorPrefix) }}
              </p>
              <p class="message-copy">{{ message.text }}</p>
              <footer>
                <time :datetime="new Date(message.senderTimestamp * 1000).toISOString()">
                  {{ formatTime(message.senderTimestamp) }}
                </time>
                <span
                  v-if="message.direction === 'out'"
                  class="delivery-status"
                  :class="message.status"
                  :aria-label="statusLabel(message)"
                  :title="statusLabel(message)"
                >
                  <template v-if="message.status === 'pending'">···</template>
                  <template v-else-if="message.status === 'sent'">✓</template>
                  <template v-else-if="message.status === 'delivered'">✓✓</template>
                  <AppIcon v-else name="alert" :size="12" />
                </span>
              </footer>
            </article>
          </div>
        </div>

        <div v-if="error" class="composer-error" role="alert">
          <AppIcon name="alert" :size="16" />
          <span>{{ error }}</span>
          <button type="button" aria-label="Dismiss error" @click="error = null">
            <AppIcon name="close" :size="15" />
          </button>
        </div>

        <form class="message-composer" @submit.prevent="send">
          <label>
            <span class="sr-only">Message {{ activeTitle }}</span>
            <textarea
              v-model="draft"
              :placeholder="composerPlaceholder"
              maxlength="2000"
              rows="1"
              @keydown.enter.exact.prevent="send"
            />
          </label>
          <span class="character-count" :class="{ near: draft.length > 1800 }">{{ draft.length }}/2000</span>
          <button class="send-button" type="submit" :disabled="sending || opening || !draft.trim()" aria-label="Send message">
            <span v-if="sending" class="send-spinner" />
            <AppIcon v-else name="send" :size="19" />
          </button>
        </form>
      </template>

      <div v-else class="no-conversation">
        <div class="signal-graphic" aria-hidden="true">
          <span class="signal-ring ring-one" />
          <span class="signal-ring ring-two" />
          <span class="signal-core"><AppIcon name="radio" :size="28" /></span>
        </div>
        <span class="instrument-label">Ready to transmit</span>
        <h2>Select a channel or node</h2>
        <p>Choose a conversation from the left to review traffic and send a message.</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.comms-layout { display: grid; height: 100%; grid-template-columns: minmax(280px, 340px) minmax(0, 1fr); background: var(--bg); }
.conversation-panel { display: flex; min-width: 0; flex-direction: column; border-right: 1px solid var(--border); background: var(--surface-1); }
.conversation-heading { display: flex; align-items: end; justify-content: space-between; padding: calc(24px * var(--space-unit)) 20px 16px; }
.conversation-heading h1 { margin: 3px 0 0; font-size: 27px; font-weight: 720; letter-spacing: -.03em; }
.total-unread { border-radius: 999px; background: var(--accent); padding: 4px 8px; color: var(--accent-ink); font-family: monospace; font-size: 10px; font-weight: 800; }
.search-field { display: flex; height: 40px; flex: 0 0 40px; align-items: center; gap: 9px; margin: 0 14px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); padding: 0 11px; color: var(--text-faint); transition: border-color 140ms ease; }
.search-field:focus-within { border-color: var(--cyan); color: var(--cyan); }
.search-field input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--text); font-size: 13px; }
.search-field input::placeholder { color: var(--text-faint); }
.conversation-scroll { min-height: 0; flex: 1; overflow-y: auto; padding: 0 9px 20px; }
.conversation-group + .conversation-group { margin-top: 19px; }
.group-heading { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; }
.group-heading h2, .group-heading span { margin: 0; color: var(--text-faint); font-family: "SFMono-Regular", Consolas, monospace; font-size: 10px; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
.conversation-row { position: relative; display: flex; width: 100%; align-items: center; gap: 10px; border: 1px solid transparent; border-radius: var(--radius-md); background: transparent; padding: calc(9px * var(--space-unit)) 9px; color: var(--text); text-align: left; cursor: pointer; transition: background 140ms ease, border-color 140ms ease; }
.conversation-row:hover { background: var(--surface-2); }
.conversation-row:disabled { cursor: wait; opacity: .62; }
.conversation-row.active { border-color: color-mix(in srgb, var(--accent) 24%, var(--border)); background: color-mix(in srgb, var(--accent) 7%, var(--surface-2)); }
.conversation-row.active::before { position: absolute; left: -10px; width: 3px; height: 30px; border-radius: 0 3px 3px 0; background: var(--accent); content: ""; }
.conversation-avatar { display: grid; width: 36px; height: 36px; flex: 0 0 36px; place-items: center; border: 1px solid var(--border); border-radius: 50%; background: var(--surface-3); color: var(--text-muted); }
.channel-avatar { border-radius: 8px; color: var(--cyan); }
.conversation-row.active .conversation-avatar { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); color: var(--accent); }
.conversation-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 2px; }
.conversation-copy strong { overflow: hidden; font-size: 13px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.conversation-copy small { color: var(--text-faint); font-family: monospace; font-size: 9px; letter-spacing: .04em; text-transform: uppercase; }
.unread-badge { display: grid; min-width: 20px; height: 20px; place-items: center; border-radius: 10px; background: var(--accent); padding: 0 5px; color: var(--accent-ink); font-family: monospace; font-size: 10px; font-weight: 800; }
.group-empty { margin: 4px 10px; color: var(--text-faint); font-size: 12px; line-height: 1.5; }
.group-heading-tools { display: flex; align-items: center; gap: 8px; }
.group-add { display: grid; width: 24px; height: 24px; place-items: center; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-2); color: var(--text-muted); cursor: pointer; transition: border-color 140ms ease, color 140ms ease; }
.group-add:hover, .group-add[aria-expanded="true"] { border-color: var(--accent); color: var(--accent); }
.import-form { position: relative; display: flex; gap: 6px; margin: 2px 10px 10px; flex-wrap: wrap; }
.import-form label { min-width: 0; flex: 1; }
.import-form input { width: 100%; height: 36px; border: 1px solid var(--border); border-radius: var(--radius-sm); outline: 0; background: var(--surface-2); padding: 0 9px; color: var(--text); font-family: monospace; font-size: 11px; }
.import-form input:focus { border-color: var(--cyan); }
.import-form input::placeholder { color: var(--text-faint); }
.import-submit { height: 36px; border: 1px solid var(--accent); border-radius: var(--radius-sm); background: var(--accent); padding: 0 11px; color: var(--accent-ink); font-size: 11px; font-weight: 750; cursor: pointer; }
.import-submit:disabled { opacity: .5; cursor: not-allowed; }
.import-error { width: 100%; margin: 0; color: var(--danger); font-size: 10px; }
.channel-form { display: flex; flex-direction: column; gap: 9px; margin: 2px 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface-2); padding: 11px; }
.channel-form label { display: flex; flex-direction: column; gap: 4px; }
.channel-form label > span { color: var(--text-muted); font-size: 10px; font-weight: 650; }
.channel-form input, .channel-form select { width: 100%; height: 36px; border: 1px solid var(--border); border-radius: var(--radius-sm); outline: 0; background: var(--surface-1); padding: 0 9px; color: var(--text); font-size: 11px; }
.channel-form input:focus, .channel-form select:focus { border-color: var(--cyan); }
.channel-form input::placeholder { color: var(--text-faint); }
.secret-row { display: flex; gap: 6px; }
.secret-row input { min-width: 0; flex: 1; font-family: monospace; }
.secret-row button { height: 36px; flex: 0 0 auto; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-3); padding: 0 10px; color: var(--text); font-size: 10px; font-weight: 700; cursor: pointer; }
.secret-row button:hover { border-color: var(--cyan); color: var(--cyan); }
.channel-submit { align-self: flex-end; }
.thread-panel { display: flex; min-width: 0; flex-direction: column; background: var(--bg); }
.thread-heading { display: flex; min-height: 70px; flex: 0 0 70px; align-items: center; gap: 11px; border-bottom: 1px solid var(--border); background: var(--surface-1); padding: 0 22px; }
.thread-avatar { display: grid; width: 38px; height: 38px; place-items: center; border: 1px solid var(--border); border-radius: 9px; background: var(--surface-2); color: var(--accent); }
.thread-title { min-width: 0; }
.thread-title h2 { overflow: hidden; margin: 0; font-size: 15px; font-weight: 680; text-overflow: ellipsis; white-space: nowrap; }
.thread-title p { overflow: hidden; margin: 3px 0 0; color: var(--text-faint); font-family: monospace; font-size: 9px; letter-spacing: .04em; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap; }
.secure-indicator { display: flex; align-items: center; gap: 7px; margin-left: auto; color: var(--text-faint); font-family: monospace; font-size: 9px; letter-spacing: .08em; text-transform: uppercase; }
.secure-indicator > span { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 60%, transparent); }
.mobile-back { display: none; width: 44px; height: 44px; place-items: center; border: 0; background: transparent; color: var(--text-muted); }
.details-toggle { display: grid; width: 40px; height: 40px; place-items: center; border: 1px solid var(--border); border-radius: var(--radius-sm); background: transparent; color: var(--text-muted); cursor: pointer; transition: border-color 140ms ease, color 140ms ease; }
.details-toggle:hover, .details-toggle[aria-expanded="true"] { border-color: var(--cyan); color: var(--cyan); }
.details-panel { border-bottom: 1px solid var(--border); background: var(--surface-1); padding: 13px 22px 15px; }
.details-facts { display: flex; flex-wrap: wrap; gap: 8px 26px; margin: 0 0 11px; }
.details-facts > div { display: flex; flex-direction: column; gap: 3px; }
.details-facts dt { color: var(--text-faint); font-family: monospace; font-size: 8px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
.details-facts dd { margin: 0; color: var(--text); font-family: monospace; font-size: 11px; }
.details-notice { margin: 0 0 10px; color: var(--accent); font-size: 11px; }
.secret-value { letter-spacing: .03em; }
.node-login { margin: 0 0 12px; }
.node-login .instrument-label { display: block; margin-bottom: 6px; }
.node-login-row { display: flex; gap: 7px; max-width: 380px; }
.node-login-row input { min-width: 0; height: 38px; flex: 1; border: 1px solid var(--border); border-radius: var(--radius-sm); outline: 0; background: var(--surface-2); padding: 0 10px; color: var(--text); font-size: 12px; }
.node-login-row input:focus { border-color: var(--cyan); }
.node-login-row button { height: 38px; flex: 0 0 auto; border: 1px solid var(--accent); border-radius: var(--radius-sm); background: var(--accent); padding: 0 13px; color: var(--accent-ink); font-size: 11px; font-weight: 750; cursor: pointer; }
.node-login-row button:disabled { opacity: .5; cursor: not-allowed; }
.node-stats { border-top: 1px solid var(--border); margin-top: 2px; padding-top: 11px; }
.details-actions { display: flex; flex-wrap: wrap; gap: 7px; }
.details-actions button, .details-actions a { display: inline-flex; min-height: 36px; align-items: center; gap: 6px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); padding: 0 11px; color: var(--text); font-size: 11px; font-weight: 700; text-decoration: none; cursor: pointer; transition: border-color 140ms ease, color 140ms ease; }
.details-actions button:hover:not(:disabled), .details-actions a:hover { border-color: var(--cyan); color: var(--cyan); }
.details-actions button:disabled { opacity: .5; cursor: not-allowed; }
.details-actions .danger { color: var(--danger); }
.details-actions .danger:hover:not(:disabled) { border-color: var(--danger); color: var(--danger); }
.message-thread { min-height: 0; flex: 1; overflow-y: auto; padding: calc(28px * var(--space-unit)) clamp(18px, 4vw, 58px); }
.message-row { display: flex; margin-bottom: calc(11px * var(--space-unit)); }
.message-row.out { justify-content: flex-end; }
.message-bubble { max-width: min(68%, 680px); border: 1px solid var(--border); border-radius: 13px 13px 13px 4px; background: var(--surface-2); padding: calc(10px * var(--space-unit)) 12px 8px; box-shadow: 0 8px 20px rgb(0 0 0 / .08); }
.message-row.out .message-bubble { border-color: color-mix(in srgb, var(--accent) 34%, var(--border)); border-radius: 13px 13px 4px 13px; background: color-mix(in srgb, var(--accent) 10%, var(--surface-2)); }
.message-sender { margin: 0 0 4px; color: var(--cyan); font-family: monospace; font-size: 10px; font-weight: 700; }
.message-copy { margin: 0; color: var(--text); font-size: 13px; line-height: 1.55; overflow-wrap: anywhere; white-space: pre-wrap; }
.message-bubble footer { display: flex; align-items: center; justify-content: flex-end; gap: 5px; margin-top: 5px; color: var(--text-faint); font-family: monospace; font-size: 9px; }
.delivery-status { display: inline-flex; align-items: center; min-width: 15px; color: var(--text-faint); font-size: 10px; font-weight: 800; letter-spacing: -2px; }
.delivery-status.delivered { color: var(--accent); }
.delivery-status.failed { color: var(--danger); letter-spacing: 0; }
.thread-state, .no-conversation { display: flex; height: 100%; flex-direction: column; align-items: center; justify-content: center; color: var(--text-faint); text-align: center; }
.thread-state h3, .no-conversation h2 { margin: 12px 0 5px; color: var(--text); font-size: 18px; }
.thread-state p, .no-conversation p { max-width: 350px; margin: 0; font-size: 12px; line-height: 1.55; }
.empty-signal { display: grid; width: 54px; height: 54px; place-items: center; border: 1px solid var(--border); border-radius: 50%; color: var(--text-faint); }
.loading-mark { width: 24px; height: 24px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 800ms linear infinite; }
.composer-error { display: flex; align-items: center; gap: 8px; border-top: 1px solid color-mix(in srgb, var(--danger) 30%, var(--border)); background: color-mix(in srgb, var(--danger) 8%, var(--surface-1)); padding: 8px clamp(18px, 4vw, 58px); color: var(--danger); font-size: 12px; }
.composer-error button { display: grid; width: 44px; height: 44px; margin: -10px -10px -10px auto; place-items: center; border: 0; background: transparent; color: currentColor; cursor: pointer; }
.message-composer { display: flex; min-height: 74px; flex: 0 0 auto; align-items: center; gap: 9px; border-top: 1px solid var(--border); background: var(--surface-1); padding: 12px clamp(14px, 3vw, 38px); }
.message-composer label { min-width: 0; flex: 1; }
.message-composer textarea { display: block; width: 100%; max-height: 104px; resize: none; border: 1px solid var(--border); border-radius: var(--radius-md); outline: 0; background: var(--surface-2); padding: 11px 13px; color: var(--text); font-size: 13px; line-height: 1.35; }
.message-composer textarea:focus { border-color: var(--cyan); }
.message-composer textarea::placeholder { color: var(--text-faint); }
.character-count { color: var(--text-faint); font-family: monospace; font-size: 9px; }
.character-count.near { color: var(--amber); }
.send-button { display: grid; width: 44px; height: 44px; flex: 0 0 44px; place-items: center; border: 0; border-radius: var(--radius-md); background: var(--accent); color: var(--accent-ink); cursor: pointer; transition: background 140ms ease, transform 140ms ease; }
.send-button:hover:not(:disabled) { background: var(--accent-strong); transform: translateY(-1px); }
.send-button:disabled { background: var(--surface-3); color: var(--text-faint); cursor: not-allowed; }
.send-spinner { width: 15px; height: 15px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: spin 700ms linear infinite; }
.signal-graphic { position: relative; width: 130px; height: 130px; margin-bottom: 28px; }
.signal-ring { position: absolute; inset: 0; border: 1px solid var(--border); border-radius: 50%; }
.ring-two { inset: 22px; border-color: var(--border-strong); }
.signal-core { position: absolute; inset: 42px; display: grid; place-items: center; border-radius: 50%; background: var(--accent); color: var(--accent-ink); }
.no-conversation .instrument-label { color: var(--accent); }
.no-conversation h2 { margin-top: 8px; font-size: 22px; letter-spacing: -.02em; }
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 720px) {
  .comms-layout { display: block; }
  .conversation-panel, .thread-panel { width: 100%; height: 100%; }
  .thread-panel { display: none; }
  .comms-layout.thread-is-open .conversation-panel { display: none; }
  .comms-layout.thread-is-open .thread-panel { display: flex; }
  .conversation-heading { padding: 18px 17px 14px; }
  .conversation-heading h1 { font-size: 24px; }
  .conversation-scroll { padding-inline: 7px; }
  .mobile-back { display: grid; margin-left: -7px; }
  .thread-heading { min-height: 58px; flex-basis: 58px; padding: 0 12px; }
  .thread-avatar { width: 34px; height: 34px; }
  .secure-indicator { display: none; }
  .details-toggle { margin-left: auto; }
  .details-panel { padding-inline: 14px; }
  .message-thread { padding: 18px 12px; }
  .message-bubble { max-width: 84%; }
  .character-count { display: none; }
  .message-composer { min-height: 66px; padding: 10px; }
}
</style>
