<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import { api } from "../api/client";
import { useAppStore } from "../stores/app";

const store = useAppStore();
const busy = ref<string | null>(null);
const notice = ref<string | null>(null);
const errorText = ref<string | null>(null);

const form = reactive({
  name: "",
  lat: "",
  lon: "",
  txPower: "",
});

watch(
  () => store.self,
  (self) => {
    if (!self) return;
    form.name = self.name;
    form.lat = self.lat?.toString() ?? "";
    form.lon = self.lon?.toString() ?? "";
    form.txPower = String(self.txPower);
  },
  { immediate: true },
);

async function run(label: string, fn: () => Promise<void>) {
  busy.value = label;
  notice.value = null;
  errorText.value = null;
  try {
    await fn();
    notice.value = `${label} done`;
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : `${label} failed`;
  } finally {
    busy.value = null;
  }
}

const saveDevice = () =>
  run("save settings", async () => {
    const patch: Record<string, unknown> = {};
    if (form.name && form.name !== store.self?.name) patch.name = form.name;
    const lat = Number.parseFloat(form.lat);
    const lon = Number.parseFloat(form.lon);
    if (!Number.isNaN(lat) && !Number.isNaN(lon) && (lat !== store.self?.lat || lon !== store.self?.lon)) {
      patch.lat = lat;
      patch.lon = lon;
    }
    const txPower = Number.parseInt(form.txPower, 10);
    if (!Number.isNaN(txPower) && txPower !== store.self?.txPower) patch.txPower = txPower;
    if (Object.keys(patch).length === 0) return;
    await api("/device", { method: "PATCH", body: JSON.stringify(patch) });
    await store.refreshStatus();
  });

const sendAdvert = (flood: boolean) =>
  run(flood ? "flood advert" : "advert", async () => {
    await api("/advert", { method: "POST", body: JSON.stringify({ flood }) });
  });

const releaseRadio = () =>
  run("release", async () => {
    await api("/connection/release", { method: "POST" });
    await store.refreshStatus();
  });

const claimRadio = () =>
  run("claim", async () => {
    await api("/connection/claim", { method: "POST" });
    await store.refreshStatus();
  });

// ---- API tokens ----
interface TokenRow {
  id: number;
  label: string;
  created_at: number;
  last_used_at: number | null;
}
const tokens = ref<TokenRow[]>([]);
const newTokenLabel = ref("");
const mintedToken = ref<string | null>(null);

async function loadTokens() {
  const result = await api<{ tokens: TokenRow[] }>("/tokens");
  tokens.value = result.tokens;
}
void loadTokens();

const createToken = () =>
  run("create token", async () => {
    const created = await api<TokenRow & { token: string }>("/tokens", {
      method: "POST",
      body: JSON.stringify({ label: newTokenLabel.value || "unnamed" }),
    });
    mintedToken.value = created.token;
    newTokenLabel.value = "";
    await loadTokens();
  });

const deleteToken = (id: number) =>
  run("delete token", async () => {
    await api(`/tokens/${id}`, { method: "DELETE" });
    await loadTokens();
  });

function fmtDate(epoch: number | null): string {
  return epoch ? new Date(epoch * 1000).toLocaleString() : "never";
}
</script>

<template>
  <div class="mx-auto max-w-3xl space-y-6 overflow-y-auto p-6" style="max-height: 100%">
    <p v-if="notice" class="rounded-lg bg-emerald-50 px-4 py-2 text-sm text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
      {{ notice }}
    </p>
    <p v-if="errorText" class="rounded-lg bg-rose-50 px-4 py-2 text-sm text-rose-600 dark:bg-rose-950 dark:text-rose-300">
      {{ errorText }}
    </p>

    <section class="rounded-xl bg-white p-5 shadow-sm dark:bg-slate-900">
      <h2 class="mb-3 text-base font-semibold">This node</h2>
      <dl v-if="store.self" class="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
        <div><dt class="text-slate-400">Public key</dt><dd class="font-mono text-xs">{{ store.self.publicKey.slice(0, 16) }}…</dd></div>
        <div><dt class="text-slate-400">Firmware</dt><dd>v{{ store.self.firmwareVer ?? "?" }} · {{ store.self.firmwareBuildDate ?? "" }}</dd></div>
        <div><dt class="text-slate-400">Model</dt><dd>{{ store.self.manufacturerModel ?? "unknown" }}</dd></div>
        <div><dt class="text-slate-400">Frequency</dt><dd>{{ (store.self.radioFreq / 1e6).toFixed(3) }} MHz</dd></div>
        <div><dt class="text-slate-400">BW / SF / CR</dt><dd>{{ store.self.radioBw / 1000 }}k / {{ store.self.radioSf }} / {{ store.self.radioCr }}</dd></div>
        <div><dt class="text-slate-400">Battery</dt><dd>{{ store.status?.batteryMilliVolts ?? "?" }} mV</dd></div>
      </dl>
      <p v-else class="text-sm text-slate-400">Not synced with a radio yet.</p>
    </section>

    <section class="rounded-xl bg-white p-5 shadow-sm dark:bg-slate-900">
      <h2 class="mb-3 text-base font-semibold">Settings</h2>
      <form class="grid grid-cols-2 gap-3 sm:grid-cols-4" @submit.prevent="saveDevice">
        <label class="col-span-2 text-sm">
          <span class="mb-1 block text-slate-500">Node name</span>
          <input v-model="form.name" maxlength="31" class="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-700" />
        </label>
        <label class="text-sm">
          <span class="mb-1 block text-slate-500">Latitude</span>
          <input v-model="form.lat" inputmode="decimal" class="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-700" />
        </label>
        <label class="text-sm">
          <span class="mb-1 block text-slate-500">Longitude</span>
          <input v-model="form.lon" inputmode="decimal" class="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-700" />
        </label>
        <label class="text-sm">
          <span class="mb-1 block text-slate-500">TX power (dBm)</span>
          <input v-model="form.txPower" inputmode="numeric" class="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-700" />
        </label>
        <div class="col-span-2 flex items-end sm:col-span-3">
          <button type="submit" :disabled="busy !== null" class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
            Save settings
          </button>
        </div>
      </form>
    </section>

    <section class="rounded-xl bg-white p-5 shadow-sm dark:bg-slate-900">
      <h2 class="mb-3 text-base font-semibold">Advert</h2>
      <p class="mb-3 text-sm text-slate-500">Announce this node so nearby nodes add you as a contact.</p>
      <div class="flex gap-2">
        <button :disabled="busy !== null" class="rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-40" @click="sendAdvert(false)">
          Send advert (zero hop)
        </button>
        <button :disabled="busy !== null" class="rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-40" @click="sendAdvert(true)">
          Send flood advert
        </button>
      </div>
    </section>

    <section class="rounded-xl bg-white p-5 shadow-sm dark:bg-slate-900">
      <h2 class="mb-3 text-base font-semibold">Radio ownership</h2>
      <p class="mb-3 text-sm text-slate-500">
        Connection: <span class="font-medium capitalize">{{ store.connectionState }}</span>
        <template v-if="store.status?.connection.target"> · {{ store.status.connection.transport }} @ {{ store.status.connection.target }}</template>
        — release the radio before connecting to it from another app or a browser.
      </p>
      <div class="flex gap-2">
        <button
          v-if="store.connectionState !== 'standby'"
          :disabled="busy !== null"
          class="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          @click="releaseRadio"
        >
          Release radio (standby)
        </button>
        <button
          v-else
          :disabled="busy !== null"
          class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          @click="claimRadio"
        >
          Claim radio
        </button>
      </div>
    </section>

    <section class="rounded-xl bg-white p-5 shadow-sm dark:bg-slate-900">
      <h2 class="mb-3 text-base font-semibold">API tokens</h2>
      <p class="mb-3 text-sm text-slate-500">
        Tokens grant read/write API access — used by the home-lab-launcher plugin.
      </p>
      <div v-if="mintedToken" class="mb-3 rounded-lg bg-amber-50 p-3 text-sm dark:bg-amber-950">
        Copy this token now — it won't be shown again:
        <code class="mt-1 block break-all font-mono text-xs">{{ mintedToken }}</code>
      </div>
      <form class="mb-3 flex gap-2" @submit.prevent="createToken">
        <input
          v-model="newTokenLabel"
          placeholder="label (e.g. home-lab-launcher)"
          class="flex-1 rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-sm dark:border-slate-700"
        />
        <button type="submit" :disabled="busy !== null" class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
          Create token
        </button>
      </form>
      <table v-if="tokens.length" class="w-full text-left text-sm">
        <thead class="text-xs uppercase text-slate-400">
          <tr><th class="py-1">Label</th><th>Created</th><th>Last used</th><th /></tr>
        </thead>
        <tbody>
          <tr v-for="token in tokens" :key="token.id" class="border-t border-slate-100 dark:border-slate-800">
            <td class="py-2">{{ token.label }}</td>
            <td>{{ fmtDate(token.created_at) }}</td>
            <td>{{ fmtDate(token.last_used_at) }}</td>
            <td class="text-right">
              <button class="text-rose-500 hover:underline" @click="deleteToken(token.id)">revoke</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>
