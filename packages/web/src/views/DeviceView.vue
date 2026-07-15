<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import type { ConnectionSettings, TelemetryPoint } from "@meshkeep/shared";
import { api } from "../api/client";
import { useAppStore } from "../stores/app";
import { browserRadioSupport, type BrowserRadioKind } from "../sources/browser-radio";
import AppIcon from "../components/AppIcon.vue";

const store = useAppStore();
const busy = ref<string | null>(null);
const notice = ref<string | null>(null);
const errorText = ref<string | null>(null);
const tokenLoadError = ref(false);
const fieldErrors = reactive({ lat: "", lon: "", txPower: "" });

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
    notice.value = `${label} complete`;
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : `${label} failed`;
  } finally {
    busy.value = null;
  }
}

const saveDevice = async () => {
  fieldErrors.lat = "";
  fieldErrors.lon = "";
  fieldErrors.txPower = "";
  const patch: Record<string, unknown> = {};
  if (form.name && form.name !== store.self?.name) patch.name = form.name;

  const hasLatitude = form.lat.trim() !== "";
  const hasLongitude = form.lon.trim() !== "";
  const lat = Number.parseFloat(form.lat);
  const lon = Number.parseFloat(form.lon);
  if (hasLatitude !== hasLongitude) {
    fieldErrors.lat = hasLatitude ? "" : "Required with longitude";
    fieldErrors.lon = hasLongitude ? "" : "Required with latitude";
  } else if (hasLatitude && (Number.isNaN(lat) || lat < -90 || lat > 90)) {
    fieldErrors.lat = "Enter a value from -90 to 90";
  } else if (hasLongitude && (Number.isNaN(lon) || lon < -180 || lon > 180)) {
    fieldErrors.lon = "Enter a value from -180 to 180";
  } else if (hasLatitude && hasLongitude && (lat !== store.self?.lat || lon !== store.self?.lon)) {
    patch.lat = lat;
    patch.lon = lon;
  }

  const txPower = Number.parseInt(form.txPower, 10);
  if (form.txPower.trim() && (Number.isNaN(txPower) || String(txPower) !== form.txPower.trim())) {
    fieldErrors.txPower = "Enter a whole number";
  } else if (form.txPower.trim() && txPower !== store.self?.txPower) {
    patch.txPower = txPower;
  }

  if (fieldErrors.lat || fieldErrors.lon || fieldErrors.txPower) {
    errorText.value = "Review the highlighted settings";
    return;
  }
  if (Object.keys(patch).length === 0) {
    notice.value = "No settings changed";
    return;
  }

  await run("Settings update", async () => {
    await api("/device", { method: "PATCH", body: JSON.stringify(patch) });
    await store.refreshStatus();
  });
};

const sendAdvert = (flood: boolean) =>
  run(flood ? "Flood advert" : "Zero-hop advert", async () => {
    await store.sendAdvert(flood);
  });

// ---- radio source (server vs this browser) ----

const webSerialBlocked = browserRadioSupport("webserial");
const webBleBlocked = browserRadioSupport("webble");
const privateSession = ref(false);

const startBrowserRadio = (kind: BrowserRadioKind) =>
  run(kind === "webserial" ? "Browser USB radio" : "Browser Bluetooth radio", async () => {
    await store.startBrowserRadio(kind, privateSession.value);
  });

const stopBrowserRadio = () =>
  run("Radio handback", async () => {
    await store.stopBrowserRadio(true);
  });

const releaseRadio = () =>
  run("Radio release", async () => {
    await api("/connection/release", { method: "POST" });
    await store.refreshStatus();
  });

const claimRadio = () =>
  run("Radio claim", async () => {
    await api("/connection/claim", { method: "POST" });
    await store.refreshStatus();
  });

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
  try {
    const result = await api<{ tokens: TokenRow[] }>("/tokens");
    tokens.value = result.tokens;
    tokenLoadError.value = false;
  } catch {
    tokenLoadError.value = true;
  }
}
void loadTokens();

const createToken = () =>
  run("Token creation", async () => {
    const created = await api<TokenRow & { token: string }>("/tokens", {
      method: "POST",
      body: JSON.stringify({ label: newTokenLabel.value || "unnamed" }),
    });
    mintedToken.value = created.token;
    newTokenLabel.value = "";
    await loadTokens();
  });

const deleteToken = (id: number) =>
  run("Token revocation", async () => {
    await api(`/tokens/${id}`, { method: "DELETE" });
    await loadTokens();
  });

async function copyToken() {
  if (!mintedToken.value) return;
  try {
    await navigator.clipboard.writeText(mintedToken.value);
    notice.value = "Token copied to clipboard";
  } catch {
    errorText.value = "Clipboard access was denied";
  }
}

function fmtDate(epoch: number | null): string {
  return epoch ? new Date(epoch * 1000).toLocaleString() : "Never";
}

// ---- RF parameters ----

const rfForm = reactive({ freqMhz: "", bwKhz: "", sf: "10", cr: "5" });
const rfError = ref<string | null>(null);

watch(
  () => store.self,
  (self) => {
    if (!self) return;
    // firmware transports frequency in kHz, bandwidth in Hz
    rfForm.freqMhz = (self.radioFreq / 1000).toString();
    rfForm.bwKhz = (self.radioBw / 1000).toString();
    rfForm.sf = String(self.radioSf);
    rfForm.cr = String(self.radioCr);
  },
  { immediate: true },
);

const saveRfParams = async () => {
  rfError.value = null;
  const freqMhz = Number.parseFloat(rfForm.freqMhz);
  const bwKhz = Number.parseFloat(rfForm.bwKhz);
  if (Number.isNaN(freqMhz) || freqMhz < 100 || freqMhz > 2500) {
    rfError.value = "Frequency must be 100–2500 MHz";
    return;
  }
  if (Number.isNaN(bwKhz) || bwKhz < 7 || bwKhz > 1000) {
    rfError.value = "Bandwidth must be 7–1000 kHz";
    return;
  }
  const patch = {
    radioFreq: Math.round(freqMhz * 1000),
    radioBw: Math.round(bwKhz * 1000),
    radioSf: Number.parseInt(rfForm.sf, 10),
    radioCr: Number.parseInt(rfForm.cr, 10),
  };
  const self = store.self;
  if (
    self &&
    patch.radioFreq === self.radioFreq &&
    patch.radioBw === self.radioBw &&
    patch.radioSf === self.radioSf &&
    patch.radioCr === self.radioCr
  ) {
    notice.value = "No RF parameters changed";
    return;
  }
  if (!window.confirm("Changing RF parameters will drop the node off its current mesh unless every peer matches. Continue?")) {
    return;
  }
  await run("RF update", async () => {
    await api("/device", { method: "PATCH", body: JSON.stringify(patch) });
    await store.refreshStatus();
  });
};

// ---- battery history ----

const telemetryHours = ref(24);
const telemetryPoints = ref<TelemetryPoint[]>([]);
const telemetryError = ref(false);

async function loadTelemetry() {
  try {
    const result = await api<{ points: TelemetryPoint[] }>(`/telemetry?hours=${telemetryHours.value}`);
    telemetryPoints.value = result.points.filter((p) => p.batteryMv !== null);
    telemetryError.value = false;
  } catch {
    telemetryError.value = true;
  }
}
watch(telemetryHours, loadTelemetry);
// the server polls the battery every 5 minutes; follow along via the live status value
watch(
  () => store.status?.batteryMilliVolts,
  () => void loadTelemetry(),
);

const chart = computed(() => {
  const points = telemetryPoints.value;
  if (points.length < 2) return null;
  const values = points.map((p) => p.batteryMv!);
  const minMv = Math.min(...values);
  const maxMv = Math.max(...values);
  const span = Math.max(maxMv - minMv, 50); // keep a flat line from filling the chart
  const mid = (minMv + maxMv) / 2;
  const t0 = points[0].ts;
  const t1 = points[points.length - 1].ts;
  const dt = Math.max(t1 - t0, 1);
  const coords = points.map((p) => {
    const x = ((p.ts - t0) / dt) * 300;
    const y = 74 - ((p.batteryMv! - (mid - span / 2)) / span) * 68;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return {
    line: coords.join(" "),
    area: `0,80 ${coords.join(" ")} 300,80`,
    minMv,
    maxMv,
    from: new Date(t0 * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
    to: new Date(t1 * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
  };
});

// ---- connection config ----

interface ConnConfig {
  env: ConnectionSettings;
  override: Partial<ConnectionSettings> | null;
  effective: ConnectionSettings;
}

const connConfig = ref<ConnConfig | null>(null);
const connError = ref(false);
const connForm = reactive({ transport: "none", serialPort: "", tcpHost: "", tcpPort: "5000", bleAddress: "" });

function seedConnForm(settings: ConnectionSettings) {
  connForm.transport = settings.connection;
  connForm.serialPort = settings.serialPort ?? "";
  connForm.tcpHost = settings.tcpHost ?? "";
  connForm.tcpPort = String(settings.tcpPort);
  connForm.bleAddress = settings.bleAddress ?? "";
}

async function loadConnConfig() {
  try {
    connConfig.value = await api<ConnConfig>("/connection/config");
    seedConnForm(connConfig.value.effective);
    connError.value = false;
  } catch {
    connError.value = true;
  }
}

const saveConnConfig = () =>
  run("Connection update", async () => {
    const override: Record<string, unknown> = { connection: connForm.transport };
    if (connForm.transport === "serial") override.serialPort = connForm.serialPort || null;
    if (connForm.transport === "tcp") {
      override.tcpHost = connForm.tcpHost || null;
      override.tcpPort = Number.parseInt(connForm.tcpPort, 10) || 5000;
    }
    if (connForm.transport === "ble") override.bleAddress = connForm.bleAddress || null;
    connConfig.value = await api<ConnConfig>("/connection/config", {
      method: "PUT",
      body: JSON.stringify({ override }),
    });
    seedConnForm(connConfig.value.effective);
    await store.refreshStatus();
  });

const clearConnConfig = () =>
  run("Connection reset", async () => {
    connConfig.value = await api<ConnConfig>("/connection/config", {
      method: "PUT",
      body: JSON.stringify({ override: null }),
    });
    seedConnForm(connConfig.value.effective);
    await store.refreshStatus();
  });

// ---- sharing & export ----

async function copyShareUri() {
  await run("Share link", async () => {
    const { uri } = await api<{ uri: string }>("/device/share");
    await navigator.clipboard.writeText(uri);
  });
  if (!errorText.value) notice.value = "meshcore:// link copied to clipboard";
}

onMounted(() => {
  void loadTelemetry();
  void loadConnConfig();
});
</script>

<template>
  <div class="radio-view">
    <header class="page-heading">
      <div>
        <span class="instrument-label">Companion hardware</span>
        <h1>Radio</h1>
        <p>Identity, link parameters, and service access for this MeshCore node.</p>
      </div>
      <div class="heading-state" :class="store.connectionState">
        <i />
        <span>
          <small>Link state</small>
          <strong>{{ store.connectionState }}</strong>
        </span>
      </div>
    </header>

    <TransitionGroup name="notice" tag="div" class="notices">
      <div v-if="notice" key="notice" class="notice success" role="status">
        <AppIcon name="check" :size="17" />
        <span>{{ notice }}</span>
        <button type="button" aria-label="Dismiss notice" @click="notice = null"><AppIcon name="close" :size="15" /></button>
      </div>
      <div v-if="errorText" key="error" class="notice error" role="alert">
        <AppIcon name="alert" :size="17" />
        <span>{{ errorText }}</span>
        <button type="button" aria-label="Dismiss error" @click="errorText = null"><AppIcon name="close" :size="15" /></button>
      </div>
    </TransitionGroup>

    <div v-if="store.browserRadio" class="browser-mode-note">
      <AppIcon name="info" :size="16" />
      <span>
        The radio is currently driven by this browser. Node settings, RF parameters, and connection
        editing talk to the server link — hand the radio back to use them.
      </span>
    </div>

    <div class="radio-grid">
      <div class="primary-column">
        <section class="module node-module">
          <div class="module-heading">
            <div>
              <span class="module-index">01</span>
              <h2>This node</h2>
            </div>
            <span v-if="store.self" class="node-key">{{ store.self.publicKey.slice(0, 8) }}…{{ store.self.publicKey.slice(-4) }}</span>
          </div>

          <template v-if="store.self">
            <div class="node-hero">
              <div class="node-glyph"><AppIcon name="radio" :size="30" /></div>
              <div>
                <span class="instrument-label">Node identity</span>
                <h3>{{ store.self.name }}</h3>
                <p>{{ store.self.manufacturerModel ?? "Unknown hardware" }}</p>
              </div>
            </div>

            <dl class="telemetry-strip">
              <div>
                <dt>Frequency</dt>
                <dd>{{ (store.self.radioFreq / 1000).toFixed(3) }} <small>MHz</small></dd>
              </div>
              <div>
                <dt>Bandwidth</dt>
                <dd>{{ store.self.radioBw / 1000 }} <small>kHz</small></dd>
              </div>
              <div>
                <dt>Spreading</dt>
                <dd>SF{{ store.self.radioSf }} <small>/ CR{{ store.self.radioCr }}</small></dd>
              </div>
              <div>
                <dt>Battery</dt>
                <dd>{{ store.status?.batteryMilliVolts ?? "—" }} <small>mV</small></dd>
              </div>
            </dl>

            <div class="firmware-row">
              <span><small>Firmware</small>v{{ store.self.firmwareVer ?? "?" }}</span>
              <span><small>Build</small>{{ store.self.firmwareBuildDate ?? "Unknown" }}</span>
              <span><small>Transport</small>{{ store.status?.connection.transport ?? "—" }}</span>
            </div>
          </template>
          <div v-else class="module-empty">
            <AppIcon name="signal" :size="28" />
            <h3>Awaiting radio sync</h3>
            <p>Node details will appear when the companion link is available.</p>
          </div>
        </section>

        <section class="module settings-module">
          <div class="module-heading">
            <div><span class="module-index">02</span><h2>Node settings</h2></div>
            <span class="module-hint">Saved to companion</span>
          </div>
          <form class="settings-form" @submit.prevent="saveDevice">
            <label class="field field-wide">
              <span>Node name</span>
              <input v-model="form.name" maxlength="31" autocomplete="off" />
              <small>{{ form.name.length }}/31</small>
            </label>
            <label class="field" :class="{ invalid: fieldErrors.lat }">
              <span>Latitude</span>
              <input v-model="form.lat" inputmode="decimal" placeholder="00.000000" :aria-invalid="!!fieldErrors.lat" />
              <small v-if="fieldErrors.lat" class="field-error">{{ fieldErrors.lat }}</small>
            </label>
            <label class="field" :class="{ invalid: fieldErrors.lon }">
              <span>Longitude</span>
              <input v-model="form.lon" inputmode="decimal" placeholder="00.000000" :aria-invalid="!!fieldErrors.lon" />
              <small v-if="fieldErrors.lon" class="field-error">{{ fieldErrors.lon }}</small>
            </label>
            <label class="field" :class="{ invalid: fieldErrors.txPower }">
              <span>TX power</span>
              <div class="input-unit"><input v-model="form.txPower" inputmode="numeric" :aria-invalid="!!fieldErrors.txPower" /><em>dBm</em></div>
              <small v-if="fieldErrors.txPower" class="field-error">{{ fieldErrors.txPower }}</small>
            </label>
            <div class="coordinate-note">
              <AppIcon name="location" :size="16" />
              Coordinates place this node on the local network map.
            </div>
            <button class="button primary save-button" type="submit" :disabled="busy !== null">
              <span v-if="busy === 'Settings update'" class="button-spinner" />
              <AppIcon v-else name="check" :size="17" />
              Save changes
            </button>
          </form>
        </section>

        <section class="module rf-module">
          <div class="module-heading">
            <div><span class="module-index">03</span><h2>RF parameters</h2></div>
            <span class="module-hint">All peers must match</span>
          </div>
          <form class="settings-form" @submit.prevent="saveRfParams">
            <label class="field">
              <span>Frequency</span>
              <div class="input-unit"><input v-model="rfForm.freqMhz" inputmode="decimal" /><em>MHz</em></div>
            </label>
            <label class="field">
              <span>Bandwidth</span>
              <div class="input-unit"><input v-model="rfForm.bwKhz" inputmode="decimal" /><em>kHz</em></div>
            </label>
            <label class="field">
              <span>Spreading factor</span>
              <select v-model="rfForm.sf" class="field-select">
                <option v-for="sf in [5, 6, 7, 8, 9, 10, 11, 12]" :key="sf" :value="String(sf)">SF{{ sf }}</option>
              </select>
            </label>
            <label class="field">
              <span>Coding rate</span>
              <select v-model="rfForm.cr" class="field-select">
                <option v-for="cr in [5, 6, 7, 8]" :key="cr" :value="String(cr)">4/{{ cr }}</option>
              </select>
            </label>
            <div class="coordinate-note">
              <AppIcon name="alert" :size="16" />
              Nodes only hear each other when frequency, bandwidth, SF, and CR all match.
            </div>
            <p v-if="rfError" class="rf-error" role="alert">{{ rfError }}</p>
            <button class="button primary save-button" type="submit" :disabled="busy !== null">
              <span v-if="busy === 'RF update'" class="button-spinner" />
              <AppIcon v-else name="check" :size="17" />
              Apply RF settings
            </button>
          </form>
        </section>

        <section class="module power-module">
          <div class="module-heading">
            <div><span class="module-index">04</span><h2>Power history</h2></div>
            <div class="range-toggle" role="group" aria-label="History range">
              <button type="button" :class="{ active: telemetryHours === 24 }" @click="telemetryHours = 24">24h</button>
              <button type="button" :class="{ active: telemetryHours === 168 }" @click="telemetryHours = 168">7d</button>
            </div>
          </div>
          <div v-if="chart" class="chart-wrap">
            <svg viewBox="0 0 300 80" preserveAspectRatio="none" role="img" aria-label="Battery voltage history">
              <polygon :points="chart.area" class="chart-area" />
              <polyline :points="chart.line" class="chart-line" fill="none" />
            </svg>
            <div class="chart-scale">
              <span>{{ (chart.maxMv / 1000).toFixed(2) }} V</span>
              <span>{{ (chart.minMv / 1000).toFixed(2) }} V</span>
            </div>
            <div class="chart-domain">
              <span>{{ chart.from }}</span>
              <span>{{ chart.to }}</span>
            </div>
          </div>
          <div v-else class="chart-empty">
            {{ telemetryError ? "Unable to load battery history." : "Not enough telemetry yet — the battery is sampled every 5 minutes." }}
          </div>
        </section>
      </div>

      <div class="secondary-column">
        <section class="module source-module">
          <div class="module-heading">
            <div><span class="module-index">05</span><h2>Radio source</h2></div>
            <span class="module-hint" :class="{ 'override-hint': store.browserRadio }">
              {{ store.browserRadio ? "this browser" : "server" }}
            </span>
          </div>

          <template v-if="store.browserRadio">
            <div class="browser-radio-banner" :class="store.browserRadio.state">
              <span class="banner-light" />
              <div>
                <strong>
                  {{ store.browserRadio.kind === "webserial" ? "USB radio in this browser" : "Bluetooth radio in this browser" }}
                </strong>
                <p>
                  {{ store.browserRadio.state }}{{ store.browserRadio.privateSession ? " · private session (no sync-back)" : " · syncing to server history" }}
                </p>
                <p v-if="store.browserRadio.error" class="banner-error">{{ store.browserRadio.error }}</p>
              </div>
            </div>
            <div class="source-buttons">
              <button class="button warning full" type="button" :disabled="busy !== null" @click="stopBrowserRadio">
                <span v-if="busy === 'Radio handback'" class="button-spinner" />
                {{ busy === "Radio handback" ? "Handing back" : "Disconnect & hand back to server" }}
              </button>
            </div>
          </template>

          <template v-else>
            <p class="module-description">
              Drive a radio plugged into <em>this device</em> instead of the server — for use in the
              field with the same interface and history. Messages sync back to the server unless the
              session is private.
            </p>
            <label class="private-toggle">
              <input v-model="privateSession" type="checkbox" />
              <span>Private session — keep traffic in this browser only</span>
            </label>
            <div class="source-buttons">
              <button
                class="button secondary"
                type="button"
                :disabled="busy !== null || webSerialBlocked !== null"
                :title="webSerialBlocked ?? ''"
                @click="startBrowserRadio('webserial')"
              >
                <span v-if="busy === 'Browser USB radio'" class="button-spinner" />
                USB (WebSerial)
              </button>
              <button
                class="button secondary"
                type="button"
                :disabled="busy !== null || webBleBlocked !== null"
                :title="webBleBlocked ?? ''"
                @click="startBrowserRadio('webble')"
              >
                <span v-if="busy === 'Browser Bluetooth radio'" class="button-spinner" />
                Bluetooth (WebBLE)
              </button>
            </div>
            <p v-if="webSerialBlocked && webBleBlocked" class="source-note">
              {{ webSerialBlocked }}
            </p>
          </template>
        </section>

        <section class="module actions-module">
          <div class="module-heading">
            <div><span class="module-index">06</span><h2>Field actions</h2></div>
          </div>

          <div class="action-block">
            <span class="action-icon"><AppIcon name="broadcast" :size="20" /></span>
            <div class="action-copy">
              <h3>Broadcast identity</h3>
              <p>Announce this node so nearby devices can add it as a contact.</p>
            </div>
            <div class="action-buttons">
              <button class="button secondary" type="button" :disabled="busy !== null" @click="sendAdvert(false)">
                <span v-if="busy === 'Zero-hop advert'" class="button-spinner" />{{ busy === "Zero-hop advert" ? "Sending" : "Zero hop" }}
              </button>
              <button class="button secondary" type="button" :disabled="busy !== null" @click="sendAdvert(true)">
                <span v-if="busy === 'Flood advert'" class="button-spinner" />{{ busy === "Flood advert" ? "Sending" : "Flood mesh" }}
              </button>
            </div>
          </div>

          <div class="action-block">
            <span class="action-icon"><AppIcon name="link" :size="20" /></span>
            <div class="action-copy">
              <h3>Share this node</h3>
              <p>Copy a meshcore:// link others can import to add this node as a contact.</p>
            </div>
            <button class="button secondary full" type="button" :disabled="busy !== null" @click="copyShareUri">
              <span v-if="busy === 'Share link'" class="button-spinner" />{{ busy === "Share link" ? "Copying" : "Copy contact link" }}
            </button>
          </div>

          <div class="action-block">
            <span class="action-icon ownership"><AppIcon name="signal" :size="20" /></span>
            <div class="action-copy">
              <h3>Radio ownership</h3>
              <p v-if="store.status?.connection.target">
                {{ store.status.connection.transport }} · {{ store.status.connection.target }}
              </p>
              <p v-else>Release this link before connecting from another app.</p>
            </div>
            <button
              v-if="store.connectionState !== 'standby'"
              class="button warning full"
              type="button"
              :disabled="busy !== null"
              @click="releaseRadio"
            >
              <span v-if="busy === 'Radio release'" class="button-spinner" />{{ busy === "Radio release" ? "Releasing" : "Release to standby" }}
            </button>
            <button v-else class="button primary full" type="button" :disabled="busy !== null" @click="claimRadio">
              <span v-if="busy === 'Radio claim'" class="button-spinner" />{{ busy === "Radio claim" ? "Claiming" : "Claim radio" }}
            </button>
          </div>
        </section>

        <section class="module connection-module">
          <div class="module-heading">
            <div><span class="module-index">07</span><h2>Connection</h2></div>
            <span v-if="connConfig?.override" class="module-hint override-hint">override active</span>
            <span v-else class="module-hint">from environment</span>
          </div>
          <div v-if="connError" class="token-error" role="alert">Unable to load connection settings.</div>
          <form v-else class="settings-form" @submit.prevent="saveConnConfig">
            <label class="field field-wide">
              <span>Transport</span>
              <select v-model="connForm.transport" class="field-select">
                <option value="serial">USB serial</option>
                <option value="tcp">TCP (ser2net / WiFi)</option>
                <option value="ble">Bluetooth LE (experimental)</option>
                <option value="none">No radio</option>
              </select>
            </label>
            <label v-if="connForm.transport === 'serial'" class="field field-wide">
              <span>Serial device</span>
              <input v-model="connForm.serialPort" placeholder="/dev/ttyMESH" autocomplete="off" spellcheck="false" />
            </label>
            <template v-if="connForm.transport === 'tcp'">
              <label class="field">
                <span>Host</span>
                <input v-model="connForm.tcpHost" placeholder="192.168.1.20" autocomplete="off" spellcheck="false" />
              </label>
              <label class="field">
                <span>Port</span>
                <input v-model="connForm.tcpPort" inputmode="numeric" />
              </label>
            </template>
            <label v-if="connForm.transport === 'ble'" class="field field-wide">
              <span>Radio MAC address</span>
              <input v-model="connForm.bleAddress" placeholder="AA:BB:CC:DD:EE:FF" autocomplete="off" spellcheck="false" />
            </label>
            <div class="coordinate-note field-wide">
              <AppIcon name="info" :size="16" />
              Saving reconnects the radio immediately. Reset returns to the container's environment settings.
            </div>
            <div class="conn-buttons field-wide">
              <button
                v-if="connConfig?.override"
                class="button secondary"
                type="button"
                :disabled="busy !== null"
                @click="clearConnConfig"
              >
                <span v-if="busy === 'Connection reset'" class="button-spinner" />Use environment
              </button>
              <button class="button primary" type="submit" :disabled="busy !== null">
                <span v-if="busy === 'Connection update'" class="button-spinner" />
                <AppIcon v-else name="check" :size="16" /> Save &amp; reconnect
              </button>
            </div>
          </form>
        </section>

        <section class="module token-module">
          <div class="module-heading">
            <div><span class="module-index">08</span><h2>API access</h2></div>
            <span class="token-count">{{ tokens.length }} active</span>
          </div>
          <p class="module-description">Tokens grant read and write access to integrations such as home-lab-launcher.</p>

          <div v-if="mintedToken" class="minted-token">
            <div>
              <span class="instrument-label">Copy now · shown once</span>
              <code>{{ mintedToken }}</code>
            </div>
            <button type="button" aria-label="Copy API token" @click="copyToken"><AppIcon name="copy" :size="17" /></button>
          </div>

          <form class="token-form" @submit.prevent="createToken">
            <label class="field">
              <span>Token label</span>
              <input v-model="newTokenLabel" placeholder="home-lab-launcher" autocomplete="off" />
            </label>
            <button class="button primary" type="submit" :disabled="busy !== null">
              <span v-if="busy === 'Token creation'" class="button-spinner" />
              <AppIcon v-else name="key" :size="16" /> {{ busy === "Token creation" ? "Creating" : "Create token" }}
            </button>
          </form>

          <div v-if="tokenLoadError" class="token-error" role="alert">Unable to load API tokens.</div>
          <div v-else-if="tokens.length" class="token-list">
            <article v-for="token in tokens" :key="token.id" class="token-row">
              <span class="token-icon"><AppIcon name="key" :size="16" /></span>
              <div class="token-identity">
                <strong>{{ token.label }}</strong>
                <span>Created {{ fmtDate(token.created_at) }}</span>
              </div>
              <span class="token-used"><small>Last used</small>{{ fmtDate(token.last_used_at) }}</span>
              <button type="button" :disabled="busy !== null" @click="deleteToken(token.id)">
                {{ busy === "Token revocation" ? "Revoking" : "Revoke" }}
              </button>
            </article>
          </div>
          <div v-else class="token-empty">No API tokens have been created.</div>
        </section>

        <section class="module data-module">
          <div class="module-heading">
            <div><span class="module-index">09</span><h2>Data export</h2></div>
            <span class="module-hint">{{ store.status?.counts.messages ?? 0 }} messages</span>
          </div>
          <p class="module-description">
            Download the full message history stored on this server. Per-conversation exports are
            available from each conversation's details in Comms.
          </p>
          <div class="export-buttons">
            <a class="button secondary" href="/api/v1/messages/export?format=csv" download>
              <AppIcon name="download" :size="16" /> CSV
            </a>
            <a class="button secondary" href="/api/v1/messages/export?format=json" download>
              <AppIcon name="download" :size="16" /> JSON
            </a>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.radio-view { height: 100%; overflow-y: auto; background: var(--bg); padding: calc(28px * var(--space-unit)) clamp(16px, 3vw, 44px) 48px; }
.page-heading { display: flex; width: min(1180px, 100%); align-items: flex-end; justify-content: space-between; margin: 0 auto calc(24px * var(--space-unit)); }
.page-heading h1 { margin: 4px 0 4px; font-size: clamp(28px, 4vw, 40px); font-weight: 740; letter-spacing: -.045em; }
.page-heading p { margin: 0; color: var(--text-muted); font-size: 12px; }
.heading-state { display: flex; min-width: 150px; align-items: center; gap: 10px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface-1); padding: 10px 12px; }
.heading-state i { width: 8px; height: 8px; border-radius: 50%; background: var(--danger); box-shadow: 0 0 0 4px color-mix(in srgb, var(--danger) 12%, transparent); }
.heading-state.connected i { background: var(--accent); box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 12%, transparent), 0 0 12px color-mix(in srgb, var(--accent) 50%, transparent); }
.heading-state.connecting i, .heading-state.syncing i { background: var(--amber); }
.heading-state.standby i { background: var(--cyan); }
.heading-state span { display: flex; flex-direction: column; }
.heading-state small { color: var(--text-faint); font-family: monospace; font-size: 8px; letter-spacing: .1em; text-transform: uppercase; }
.heading-state strong { margin-top: 2px; font-size: 11px; text-transform: capitalize; }
.notices { position: fixed; z-index: 2500; top: 78px; right: 22px; display: flex; width: min(360px, calc(100% - 32px)); flex-direction: column; gap: 8px; }
.notice { display: flex; align-items: center; gap: 9px; border: 1px solid var(--border-strong); border-radius: var(--radius-md); background: var(--surface-raised); padding: 11px 12px; box-shadow: var(--shadow); font-size: 12px; }
.notice.success { color: var(--accent); }
.notice.error { color: var(--danger); }
.notice button { display: grid; width: 44px; height: 44px; margin: -8px -8px -8px auto; place-items: center; border: 0; background: transparent; color: currentColor; cursor: pointer; }
.notice-enter-active, .notice-leave-active { transition: opacity 150ms ease, transform 150ms ease; }
.notice-enter-from, .notice-leave-to { opacity: 0; transform: translateY(-5px); }
.browser-mode-note { display: flex; width: min(1180px, 100%); align-items: center; gap: 10px; margin: 0 auto calc(16px * var(--space-unit)); border: 1px solid color-mix(in srgb, var(--cyan) 30%, var(--border)); border-radius: var(--radius-md); background: color-mix(in srgb, var(--cyan) 6%, var(--surface-1)); padding: 11px 13px; color: var(--text-muted); font-size: 11px; line-height: 1.5; }
.browser-mode-note svg { flex: 0 0 auto; color: var(--cyan); }
.radio-grid { display: grid; width: min(1180px, 100%); grid-template-columns: minmax(0, 1.2fr) minmax(340px, .8fr); gap: 18px; margin: 0 auto; }
.primary-column, .secondary-column { display: flex; min-width: 0; flex-direction: column; gap: 18px; }
.module { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface-1); overflow: hidden; }
.module-heading { display: flex; min-height: 58px; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); padding: 0 18px; }
.module-heading > div { display: flex; align-items: center; gap: 10px; }
.module-heading h2 { margin: 0; font-size: 14px; font-weight: 680; }
.module-index { color: var(--accent); font-family: monospace; font-size: 9px; font-weight: 800; }
.module-hint, .node-key, .token-count { color: var(--text-faint); font-family: monospace; font-size: 9px; letter-spacing: .04em; text-transform: uppercase; }
.node-hero { display: flex; align-items: center; gap: 15px; padding: calc(24px * var(--space-unit)) 20px; }
.node-glyph { display: grid; width: 58px; height: 58px; flex: 0 0 58px; place-items: center; border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border)); border-radius: 12px; background: color-mix(in srgb, var(--accent) 8%, var(--surface-2)); color: var(--accent); }
.node-hero h3 { margin: 4px 0 2px; font-size: 22px; letter-spacing: -.025em; }
.node-hero p { margin: 0; color: var(--text-muted); font-size: 11px; }
.telemetry-strip { display: grid; grid-template-columns: repeat(4, 1fr); margin: 0 20px; border: 1px solid var(--border); border-radius: var(--radius-md); }
.telemetry-strip > div { min-width: 0; padding: calc(13px * var(--space-unit)) 12px; }
.telemetry-strip > div + div { border-left: 1px solid var(--border); }
.telemetry-strip dt { color: var(--text-faint); font-family: monospace; font-size: 8px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
.telemetry-strip dd { overflow: hidden; margin: 6px 0 0; color: var(--text); font-family: monospace; font-size: 14px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
.telemetry-strip dd small { color: var(--text-muted); font-size: 8px; font-weight: 500; }
.firmware-row { display: flex; flex-wrap: wrap; gap: 24px; margin: 17px 20px 20px; color: var(--text-muted); font-family: monospace; font-size: 9px; }
.firmware-row span { display: flex; gap: 6px; }
.firmware-row small { color: var(--text-faint); text-transform: uppercase; }
.module-empty { display: flex; flex-direction: column; align-items: center; padding: 38px 20px; color: var(--text-faint); text-align: center; }
.module-empty h3 { margin: 12px 0 4px; color: var(--text); font-size: 14px; }
.module-empty p { margin: 0; font-size: 11px; }
.settings-form { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; padding: 20px; }
.field { position: relative; display: flex; min-width: 0; flex-direction: column; gap: 6px; }
.field-wide { grid-column: 1 / -1; }
.field > span { color: var(--text-muted); font-size: 11px; font-weight: 650; }
.field > small { position: absolute; right: 10px; bottom: 11px; color: var(--text-faint); font-family: monospace; font-size: 9px; }
.field > .field-error { position: static; color: var(--danger); font-family: inherit; font-size: 10px; }
.field.invalid input { border-color: var(--danger); }
.field input { width: 100%; height: 40px; border: 1px solid var(--border); border-radius: var(--radius-sm); outline: 0; background: var(--surface-2); padding: 0 11px; color: var(--text); font-size: 12px; }
.field input:focus { border-color: var(--cyan); }
.field input::placeholder { color: var(--text-faint); }
.input-unit { position: relative; }
.input-unit input { padding-right: 48px; }
.input-unit em { position: absolute; top: 50%; right: 11px; color: var(--text-faint); font-family: monospace; font-size: 9px; font-style: normal; transform: translateY(-50%); }
.coordinate-note { display: flex; align-items: center; gap: 7px; color: var(--text-faint); font-size: 10px; }
.button { display: inline-flex; min-height: 44px; align-items: center; justify-content: center; gap: 7px; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0 13px; font-size: 11px; font-weight: 750; cursor: pointer; transition: border-color 140ms ease, background 140ms ease, transform 140ms ease; }
.button:hover:not(:disabled) { transform: translateY(-1px); }
.button:disabled { opacity: .45; cursor: not-allowed; }
.button.primary { border-color: var(--accent); background: var(--accent); color: var(--accent-ink); }
.button.primary:hover:not(:disabled) { background: var(--accent-strong); }
.button.secondary { background: var(--surface-2); color: var(--text); }
.button.secondary:hover:not(:disabled) { border-color: var(--cyan); color: var(--cyan); }
.button.warning { border-color: color-mix(in srgb, var(--amber) 35%, var(--border)); background: color-mix(in srgb, var(--amber) 10%, var(--surface-2)); color: var(--amber); }
.button.full { width: 100%; }
.save-button { justify-self: end; min-width: 132px; }
.button-spinner { width: 13px; height: 13px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: spin 700ms linear infinite; }
.action-block { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 10px; padding: calc(18px * var(--space-unit)); }
.action-block + .action-block { border-top: 1px solid var(--border); }
.action-icon { display: grid; width: 38px; height: 38px; place-items: center; border: 1px solid color-mix(in srgb, var(--cyan) 30%, var(--border)); border-radius: 9px; background: color-mix(in srgb, var(--cyan) 7%, var(--surface-2)); color: var(--cyan); }
.action-icon.ownership { border-color: color-mix(in srgb, var(--amber) 30%, var(--border)); background: color-mix(in srgb, var(--amber) 7%, var(--surface-2)); color: var(--amber); }
.action-copy h3 { margin: 1px 0 4px; font-size: 12px; }
.action-copy p { overflow-wrap: anywhere; margin: 0; color: var(--text-faint); font-size: 10px; line-height: 1.5; }
.action-buttons, .action-block > .button { grid-column: 2; }
.action-buttons { display: flex; gap: 7px; margin-top: 3px; }
.action-buttons .button { flex: 1; }
.module-description { margin: 16px 18px 14px; color: var(--text-muted); font-size: 10px; line-height: 1.55; }
.minted-token { display: flex; align-items: center; gap: 10px; margin: 0 18px 14px; border: 1px solid color-mix(in srgb, var(--amber) 35%, var(--border)); border-radius: var(--radius-md); background: color-mix(in srgb, var(--amber) 7%, var(--surface-2)); padding: 11px; }
.minted-token > div { min-width: 0; flex: 1; }
.minted-token .instrument-label { color: var(--amber); font-size: 8px; }
.minted-token code { display: block; overflow: hidden; margin-top: 5px; color: var(--text); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.minted-token button { display: grid; width: 44px; height: 44px; flex: 0 0 44px; place-items: center; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text); cursor: pointer; }
.token-form { display: flex; align-items: flex-end; gap: 8px; padding: 0 18px 18px; }
.token-form .field { flex: 1; }
.token-form .button { flex: 0 0 auto; }
.token-list { border-top: 1px solid var(--border); }
.token-row { display: grid; grid-template-columns: 30px minmax(0, 1fr) minmax(100px, auto) auto; align-items: center; gap: 8px; padding: calc(12px * var(--space-unit)) 18px; }
.token-row + .token-row { border-top: 1px solid var(--border); }
.token-icon { display: grid; width: 28px; height: 28px; place-items: center; border-radius: 7px; background: var(--surface-3); color: var(--text-muted); }
.token-identity { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.token-identity strong { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.token-identity span, .token-used { color: var(--text-faint); font-family: monospace; font-size: 8px; }
.token-used { display: flex; flex-direction: column; gap: 2px; text-align: right; }
.token-used small { color: var(--text-muted); font-size: 7px; text-transform: uppercase; }
.token-row button { min-width: 44px; min-height: 44px; border: 0; background: transparent; color: var(--danger); font-size: 10px; font-weight: 700; cursor: pointer; }
.token-empty, .token-error { border-top: 1px solid var(--border); padding: 18px; color: var(--text-faint); font-size: 10px; }
.token-error { color: var(--danger); }
.field-select { width: 100%; height: 40px; border: 1px solid var(--border); border-radius: var(--radius-sm); outline: 0; background: var(--surface-2); padding: 0 9px; color: var(--text); font-size: 12px; }
.field-select:focus { border-color: var(--cyan); }
.rf-error { grid-column: 1 / -1; margin: 0; color: var(--danger); font-size: 11px; }
.range-toggle { display: flex; gap: 3px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface-2); padding: 3px; }
.range-toggle button { min-width: 44px; border: 0; border-radius: 5px; background: transparent; padding: 6px 8px; color: var(--text-muted); font-family: monospace; font-size: 10px; font-weight: 700; cursor: pointer; }
.range-toggle button.active { background: var(--surface-3); color: var(--accent); }
.chart-wrap { position: relative; padding: 16px 20px 12px; }
.chart-wrap svg { display: block; width: 100%; height: 120px; }
.chart-line { stroke: var(--accent); stroke-width: 1.6; vector-effect: non-scaling-stroke; }
.chart-area { fill: color-mix(in srgb, var(--accent) 12%, transparent); }
.chart-scale { position: absolute; top: 14px; right: 26px; bottom: 34px; display: flex; flex-direction: column; justify-content: space-between; color: var(--text-faint); font-family: monospace; font-size: 9px; text-align: right; pointer-events: none; }
.chart-domain { display: flex; justify-content: space-between; margin-top: 6px; color: var(--text-faint); font-family: monospace; font-size: 9px; }
.chart-empty { padding: 26px 20px; color: var(--text-faint); font-size: 11px; }
.override-hint { color: var(--amber); }
.browser-radio-banner { display: flex; gap: 11px; margin: 16px 18px 0; border: 1px solid color-mix(in srgb, var(--cyan) 30%, var(--border)); border-radius: var(--radius-md); background: color-mix(in srgb, var(--cyan) 7%, var(--surface-2)); padding: 12px; }
.browser-radio-banner.error { border-color: color-mix(in srgb, var(--danger) 35%, var(--border)); background: color-mix(in srgb, var(--danger) 7%, var(--surface-2)); }
.banner-light { width: 8px; height: 8px; flex: 0 0 8px; margin-top: 5px; border-radius: 50%; background: var(--cyan); box-shadow: 0 0 8px color-mix(in srgb, var(--cyan) 60%, transparent); }
.browser-radio-banner.connected .banner-light { background: var(--accent); box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 60%, transparent); }
.browser-radio-banner.error .banner-light { background: var(--danger); }
.browser-radio-banner strong { font-size: 12px; }
.browser-radio-banner p { margin: 3px 0 0; color: var(--text-muted); font-size: 10px; text-transform: capitalize; }
.browser-radio-banner .banner-error { color: var(--danger); text-transform: none; }
.private-toggle { display: flex; align-items: center; gap: 9px; margin: 0 18px 13px; color: var(--text-muted); font-size: 11px; cursor: pointer; }
.private-toggle input { width: 15px; height: 15px; accent-color: var(--accent); }
.source-buttons { display: flex; gap: 8px; padding: 0 18px 16px; }
.source-buttons:not(:first-child) { padding-top: 14px; }
.source-buttons .button { flex: 1; }
.source-note { margin: -6px 18px 15px; color: var(--text-faint); font-size: 10px; }
.conn-buttons { display: flex; justify-content: flex-end; gap: 8px; }
.export-buttons { display: flex; gap: 8px; padding: 0 18px 18px; }
.export-buttons .button { flex: 1; text-decoration: none; }
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 980px) {
  .radio-grid { grid-template-columns: 1fr; }
}

@media (max-width: 720px) {
  .radio-view { padding: 18px 12px 36px; }
  .page-heading { align-items: center; }
  .page-heading p { display: none; }
  .heading-state { min-width: 0; border: 0; background: transparent; padding: 6px; }
  .heading-state small { display: none; }
  .page-heading h1 { font-size: 28px; }
  .notices { top: 64px; right: 12px; }
  .module-heading { padding: 0 14px; }
  .node-hero { padding-inline: 15px; }
  .telemetry-strip { grid-template-columns: 1fr 1fr; margin-inline: 14px; }
  .telemetry-strip > div:nth-child(3) { border-left: 0; border-top: 1px solid var(--border); }
  .telemetry-strip > div:nth-child(4) { border-top: 1px solid var(--border); }
  .firmware-row { gap: 10px 18px; margin-inline: 15px; }
  .settings-form { grid-template-columns: 1fr; padding: 15px; }
  .field-wide { grid-column: auto; }
  .coordinate-note { display: none; }
  .save-button { width: 100%; justify-self: stretch; }
  .token-form { align-items: stretch; flex-direction: column; padding-inline: 14px; }
  .token-row { grid-template-columns: 30px minmax(0, 1fr) auto; padding-inline: 14px; }
  .token-used { display: none; }
}
</style>
