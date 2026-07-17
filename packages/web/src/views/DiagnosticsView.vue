<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { ServerDiagnostics } from "@meshkeep/shared";
import { useAppStore } from "../stores/app";
import AppIcon from "../components/AppIcon.vue";

const store = useAppStore();
const diagnostics = ref<ServerDiagnostics | null>(null);
const state = ref<"loading" | "ready" | "error">("loading");
const errorText = ref<string | null>(null);

async function load() {
  state.value = "loading";
  errorText.value = null;
  try {
    diagnostics.value = await store.fetchDiagnostics();
    state.value = "ready";
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : "Failed to load diagnostics";
    state.value = "error";
  }
}

onMounted(load);

function fmtTime(seconds: number | null): string {
  return seconds ? new Date(seconds * 1000).toLocaleString() : "—";
}

function fmtDuration(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function fmtMhz(hz: number | null): string {
  return hz ? `${(hz / 1_000_000).toFixed(3)} MHz` : "—";
}

function fmtKhz(hz: number | null): string {
  return hz ? `${(hz / 1000).toFixed(0)} kHz` : "—";
}
</script>

<template>
  <div class="diag-view">
    <header class="page-heading">
      <div>
        <span class="instrument-label">Support &amp; observability</span>
        <h1>Diagnostics</h1>
        <p>Transport, firmware, database, and map health for this server — no message content or secrets.</p>
      </div>
      <div class="heading-actions">
        <button type="button" class="button secondary" :disabled="state === 'loading'" @click="load">
          <AppIcon name="signal" :size="15" />
          Refresh
        </button>
        <a class="button primary" href="/api/v1/diagnostics/bundle" download>
          <AppIcon name="download" :size="15" />
          Support bundle
        </a>
      </div>
    </header>

    <div v-if="state === 'loading'" class="diag-state">
      <span class="diag-spinner" aria-hidden="true" />
      <p>Collecting diagnostics…</p>
    </div>

    <div v-else-if="state === 'error'" class="diag-state" role="alert">
      <AppIcon name="alert" :size="26" />
      <p>{{ errorText }}</p>
      <button type="button" class="button secondary" @click="load">Retry</button>
    </div>

    <div v-else-if="diagnostics" class="diag-grid">
      <section v-if="diagnostics.guidance.length" class="guidance" aria-label="Operator guidance">
        <div v-for="(note, i) in diagnostics.guidance" :key="i" class="guidance-item">
          <AppIcon name="alert" :size="16" />
          <span>{{ note }}</span>
        </div>
      </section>

      <section class="module">
        <div class="module-heading"><div><AppIcon name="radio" :size="16" /><h2>Connection</h2></div></div>
        <dl class="spec">
          <div><dt>State</dt><dd class="capitalize">{{ diagnostics.connection.state }}</dd></div>
          <div><dt>Transport</dt><dd>{{ diagnostics.connection.transport }}</dd></div>
          <div><dt>Target</dt><dd>{{ diagnostics.connection.target ?? "—" }}</dd></div>
          <div><dt>Connected</dt><dd>{{ fmtTime(diagnostics.connection.connectedAt) }}</dd></div>
          <div>
            <dt>Reconnect</dt>
            <dd>
              {{ diagnostics.connection.reconnectScheduled
                ? `scheduled (${Math.round(diagnostics.connection.reconnectDelayMs / 1000)}s)`
                : "idle" }}
            </dd>
          </div>
          <div v-if="diagnostics.connection.lastError">
            <dt>Last error</dt><dd class="warn">{{ diagnostics.connection.lastError }}</dd>
          </div>
        </dl>
      </section>

      <section class="module">
        <div class="module-heading"><div><AppIcon name="signal" :size="16" /><h2>Firmware &amp; radio</h2></div></div>
        <dl class="spec">
          <div><dt>Model</dt><dd>{{ diagnostics.firmware.model ?? "—" }}</dd></div>
          <div><dt>Firmware</dt><dd>{{ diagnostics.firmware.version ?? "—" }}</dd></div>
          <div><dt>Build date</dt><dd>{{ diagnostics.firmware.buildDate ?? "—" }}</dd></div>
          <div><dt>Frequency</dt><dd>{{ fmtMhz(diagnostics.radio?.freqHz ?? null) }}</dd></div>
          <div><dt>Bandwidth</dt><dd>{{ fmtKhz(diagnostics.radio?.bandwidthHz ?? null) }}</dd></div>
          <div>
            <dt>SF / CR</dt>
            <dd>{{ diagnostics.radio?.spreadingFactor ?? "—" }} / {{ diagnostics.radio?.codingRate ?? "—" }}</dd>
          </div>
        </dl>
      </section>

      <section class="module">
        <div class="module-heading"><div><AppIcon name="key" :size="16" /><h2>Database</h2></div></div>
        <dl class="spec">
          <div>
            <dt>Integrity</dt>
            <dd :class="diagnostics.database.integrity === 'ok' ? 'ok' : 'warn'">{{ diagnostics.database.integrity }}</dd>
          </div>
          <div>
            <dt>FK violations</dt>
            <dd :class="diagnostics.database.foreignKeyViolations ? 'warn' : 'ok'">
              {{ diagnostics.database.foreignKeyViolations }}
            </dd>
          </div>
          <div>
            <dt>Schema</dt>
            <dd :class="diagnostics.database.schemaVersion === diagnostics.database.latestSchemaVersion ? 'ok' : 'warn'">
              v{{ diagnostics.database.schemaVersion }} / v{{ diagnostics.database.latestSchemaVersion }}
            </dd>
          </div>
          <div><dt>Journal</dt><dd>{{ diagnostics.database.journalMode }}</dd></div>
          <div><dt>Busy timeout</dt><dd>{{ diagnostics.database.busyTimeoutMs }} ms</dd></div>
          <div><dt>Size</dt><dd>{{ fmtBytes(diagnostics.database.sizeBytes) }}</dd></div>
          <div><dt>WAL pages</dt><dd>{{ diagnostics.database.walPages }}</dd></div>
        </dl>
      </section>

      <section class="module">
        <div class="module-heading"><div><AppIcon name="map" :size="16" /><h2>Map &amp; server</h2></div></div>
        <dl class="spec">
          <div><dt>Map enabled</dt><dd>{{ diagnostics.map.enabled ? "yes" : "no" }}</dd></div>
          <div><dt>Map fetched</dt><dd>{{ fmtTime(diagnostics.map.fetchedAt) }}</dd></div>
          <div v-if="diagnostics.map.lastError"><dt>Map error</dt><dd class="warn">{{ diagnostics.map.lastError }}</dd></div>
          <div><dt>Version</dt><dd>v{{ diagnostics.server.version }}</dd></div>
          <div><dt>Uptime</dt><dd>{{ fmtDuration(diagnostics.server.uptimeSeconds) }}</dd></div>
          <div><dt>Runtime</dt><dd>{{ diagnostics.server.nodeVersion }} · {{ diagnostics.server.platform }}</dd></div>
          <div>
            <dt>Records</dt>
            <dd>{{ diagnostics.counts.contacts }} contacts · {{ diagnostics.counts.messages }} messages</dd>
          </div>
        </dl>
      </section>
    </div>
  </div>
</template>

<style scoped>
.diag-view { height: 100%; overflow-y: auto; background: var(--bg); padding: calc(28px * var(--space-unit)) clamp(16px, 3vw, 44px) 48px; }
.page-heading { display: flex; width: min(1180px, 100%); align-items: flex-end; justify-content: space-between; gap: 16px; margin: 0 auto calc(24px * var(--space-unit)); }
.page-heading h1 { margin: 4px 0 4px; font-size: clamp(28px, 4vw, 40px); font-weight: 740; letter-spacing: -.045em; }
.page-heading p { margin: 0; max-width: 52ch; color: var(--text-muted); font-size: 12px; }
.instrument-label { color: var(--text-faint); font-family: monospace; font-size: 9px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
.heading-actions { display: flex; flex-shrink: 0; gap: 8px; }
.button { display: inline-flex; min-height: 44px; align-items: center; justify-content: center; gap: 7px; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0 15px; font-size: 11px; font-weight: 750; text-decoration: none; cursor: pointer; transition: border-color 140ms ease, background 140ms ease, transform 140ms ease; }
.button:hover:not(:disabled) { transform: translateY(-1px); }
.button:disabled { opacity: .45; cursor: not-allowed; }
.button.primary { border-color: var(--accent); background: var(--accent); color: var(--accent-ink); }
.button.secondary { background: var(--surface-2); color: var(--text); }
.button.secondary:hover:not(:disabled) { border-color: var(--cyan); color: var(--cyan); }
.diag-grid { display: grid; width: min(1180px, 100%); margin: 0 auto; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
.guidance { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 8px; }
.guidance-item { display: flex; align-items: flex-start; gap: 9px; border: 1px solid color-mix(in srgb, var(--amber) 35%, var(--border)); border-radius: var(--radius-md); background: color-mix(in srgb, var(--amber) 9%, var(--surface-1)); padding: 11px 13px; color: var(--amber); font-size: 12px; line-height: 1.5; }
.module { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface-1); overflow: hidden; }
.module-heading { display: flex; min-height: 52px; align-items: center; border-bottom: 1px solid var(--border); padding: 0 18px; }
.module-heading > div { display: flex; align-items: center; gap: 9px; color: var(--text-muted); }
.module-heading h2 { margin: 0; color: var(--text); font-size: 14px; font-weight: 680; }
.spec { display: grid; margin: 0; padding: 8px 18px 16px; }
.spec > div { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; padding: 7px 0; border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent); }
.spec > div:last-child { border-bottom: 0; }
.spec dt { color: var(--text-faint); font-size: 11px; font-weight: 600; }
.spec dd { margin: 0; color: var(--text); font-family: "SFMono-Regular", Consolas, monospace; font-size: 12px; text-align: right; word-break: break-word; }
.spec dd.ok { color: var(--accent); }
.spec dd.warn { color: var(--amber); }
.capitalize { text-transform: capitalize; }
.diag-state { display: flex; width: min(1180px, 100%); min-height: 240px; flex-direction: column; align-items: center; justify-content: center; gap: 14px; margin: 0 auto; color: var(--text-muted); text-align: center; }
.diag-spinner { width: 26px; height: 26px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: diag-spin 700ms linear infinite; }
@keyframes diag-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .diag-spinner { animation-duration: 2.4s; } }
@media (max-width: 720px) {
  .page-heading { flex-direction: column; align-items: flex-start; }
  .diag-grid { grid-template-columns: 1fr; }
}
</style>
