<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import L from "leaflet";
import "leaflet.markercluster";
import { api } from "../api/client";
import { useAppStore } from "../stores/app";
import AppIcon from "../components/AppIcon.vue";

const store = useAppStore();
const mapEl = ref<HTMLElement | null>(null);
const status = ref<"loading" | "ready" | "error" | "disabled">("loading");
const errorText = ref("");
const globalCount = ref(0);
const localCount = computed(
  () =>
    store.contacts.filter((contact) => hasPosition(contact.lat, contact.lon)).length +
    (hasPosition(store.self?.lat, store.self?.lon) ? 1 : 0),
);
const localNodes = computed(() => {
  const nodes: Array<{ name: string; type: string; lat: number; lon: number }> = [];
  const self = store.self;
  if (hasPosition(self?.lat, self?.lon)) nodes.push({ name: self.name, type: "this node", lat: self.lat, lon: self.lon! });
  for (const contact of store.contacts) {
    if (hasPosition(contact.lat, contact.lon)) {
      nodes.push({ name: contact.name || "unnamed node", type: contact.type, lat: contact.lat, lon: contact.lon! });
    }
  }
  return nodes;
});

let map: L.Map | null = null;
let localLayer: L.LayerGroup | null = null;

interface UpstreamNode {
  lat?: number;
  latitude?: number;
  adv_lat?: number;
  lon?: number;
  lng?: number;
  longitude?: number;
  adv_lon?: number;
  name?: string;
  node_name?: string;
  adv_name?: string;
  type?: string | number;
  [key: string]: unknown;
}

function hasPosition(lat: number | null | undefined, lon: number | null | undefined): lat is number {
  return typeof lat === "number" && typeof lon === "number" && !(lat === 0 && lon === 0);
}

/** map.meshcore.io payload shapes have shifted over time; parse defensively. */
function normalizeNodes(payload: unknown): Array<{ lat: number; lon: number; name: string; type: string }> {
  const raw: UpstreamNode[] = Array.isArray(payload)
    ? (payload as UpstreamNode[])
    : Array.isArray((payload as { nodes?: unknown })?.nodes)
      ? ((payload as { nodes: UpstreamNode[] }).nodes)
      : Array.isArray((payload as { data?: unknown })?.data)
        ? ((payload as { data: UpstreamNode[] }).data)
        : [];
  const nodes: Array<{ lat: number; lon: number; name: string; type: string }> = [];
  for (const node of raw) {
    const lat = node.lat ?? node.latitude ?? node.adv_lat;
    const lon = node.lon ?? node.lng ?? node.longitude ?? node.adv_lon;
    if (typeof lat !== "number" || typeof lon !== "number" || (lat === 0 && lon === 0)) continue;
    nodes.push({
      lat,
      lon,
      name: String(node.name ?? node.node_name ?? node.adv_name ?? "unknown"),
      type: String(node.type ?? "node"),
    });
  }
  return nodes;
}

function nodeColor(type: string): string {
  const normalized = type.toLowerCase();
  if (normalized.includes("repeater") || normalized === "2") return "#f4b860";
  if (normalized.includes("room") || normalized === "3") return "#c0a8ff";
  return "#b9f45d";
}

function circleMarker(lat: number, lon: number, color: string, radius = 6) {
  return L.circleMarker([lat, lon], {
    radius,
    color,
    weight: 2,
    fillColor: color,
    fillOpacity: 0.72,
  });
}

function fitLocalNodes() {
  if (!map) return;
  const spots: Array<[number, number]> = [];
  const self = store.self;
  if (hasPosition(self?.lat, self?.lon)) spots.push([self.lat, self.lon!]);
  for (const contact of store.contacts) {
    if (hasPosition(contact.lat, contact.lon)) spots.push([contact.lat, contact.lon!]);
  }
  if (spots.length) map.fitBounds(L.latLngBounds(spots).pad(0.5), { maxZoom: 11 });
}

function renderLocalNodes() {
  if (!localLayer) return;
  localLayer.clearLayers();
  for (const node of localNodes.value) {
    circleMarker(node.lat, node.lon, "#59dce4", node.type === "this node" ? 9 : 7)
      .bindPopup(`<b>${escapeHtml(node.name)}</b><br>${escapeHtml(node.type)}`)
      .addTo(localLayer);
  }
}

watch(localNodes, renderLocalNodes, { deep: true });

onMounted(async () => {
  if (!mapEl.value) return;
  map = L.map(mapEl.value, { zoomControl: false, attributionControl: true }).setView([30, 0], 2);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  localLayer = L.layerGroup().addTo(map);
  renderLocalNodes();

  try {
    const { nodes: payload } = await api<{ nodes: unknown }>("/map/nodes");
    const nodes = normalizeNodes(payload);
    globalCount.value = nodes.length;
    const cluster = L.markerClusterGroup({
      chunkedLoading: true,
      iconCreateFunction: (clusterMarker) =>
        L.divIcon({
          html: `<div class="mesh-cluster">${clusterMarker.getChildCount()}</div>`,
          className: "mesh-cluster-wrap",
          iconSize: [38, 38],
        }),
    });
    for (const node of nodes) {
      cluster.addLayer(
        circleMarker(node.lat, node.lon, nodeColor(node.type)).bindPopup(
          `<b>${escapeHtml(node.name)}</b><br>${escapeHtml(node.type)}`,
        ),
      );
    }
    map.addLayer(cluster);
    status.value = "ready";
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Failed to load map data";
    if (message.includes("disabled")) {
      status.value = "disabled";
    } else {
      status.value = "error";
      errorText.value = message;
    }
  }

  fitLocalNodes();
});

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

onBeforeUnmount(() => {
  map?.remove();
  map = null;
  localLayer = null;
});
</script>

<template>
  <div class="network-view">
    <div ref="mapEl" class="map-canvas" aria-label="MeshCore network map" />
    <section class="sr-only" aria-label="Network map data">
      <h2>Network map data</h2>
      <p>{{ globalCount.toLocaleString() }} global nodes and {{ localCount }} local nodes are plotted.</p>
      <ul>
        <li v-for="node in localNodes" :key="`${node.name}-${node.lat}-${node.lon}`">
          {{ node.name }}, {{ node.type }}, at {{ node.lat }}, {{ node.lon }}
        </li>
      </ul>
    </section>

    <header class="map-heading">
      <span class="instrument-label">Geospatial view</span>
      <h1>Network</h1>
      <p>Local contacts and the global MeshCore node index.</p>
    </header>

    <section class="map-readout" aria-label="Map status">
      <div class="readout-heading">
        <span class="instrument-label">Live index</span>
        <span class="map-state" :class="status">
          <i />
          {{ status }}
        </span>
      </div>
      <div class="readout-stats">
        <div>
          <strong>{{ localCount.toLocaleString() }}</strong>
          <span>Local</span>
        </div>
        <div>
          <strong>{{ status === "ready" ? globalCount.toLocaleString() : "—" }}</strong>
          <span>Global</span>
        </div>
      </div>
      <p v-if="status === 'loading'" class="map-message">Syncing cached node index…</p>
      <p v-else-if="status === 'disabled'" class="map-message">Global map data is disabled.</p>
      <p v-else-if="status === 'error'" class="map-message error" role="alert">{{ errorText }}</p>
      <button v-if="localCount" type="button" class="locate-button" @click="fitLocalNodes">
        <AppIcon name="location" :size="16" />
        Frame local mesh
      </button>
    </section>

    <section class="map-legend" aria-label="Map legend">
      <span><i class="local" /> Local mesh</span>
      <span><i class="node" /> Chat node</span>
      <span><i class="repeater" /> Repeater</span>
      <span><i class="room" /> Room</span>
    </section>
  </div>
</template>

<style scoped>
.network-view { position: relative; height: 100%; overflow: hidden; background: var(--map-bg); }
.map-canvas { width: 100%; height: 100%; background: var(--map-bg); }
.map-heading { position: absolute; z-index: 1000; top: 22px; left: 22px; width: min(330px, calc(100% - 44px)); border: 1px solid var(--border-strong); border-radius: var(--radius-md); background: var(--surface-1); padding: calc(16px * var(--space-unit)) 18px; }
.map-heading h1 { margin: 3px 0 2px; font-size: 25px; letter-spacing: -.03em; }
.map-heading p { margin: 0; color: var(--text-muted); font-size: 11px; }
.map-readout { position: absolute; z-index: 1000; top: 22px; right: 22px; width: 230px; border: 1px solid var(--border-strong); border-radius: var(--radius-md); background: var(--surface-1); padding: calc(15px * var(--space-unit)); }
.readout-heading { display: flex; align-items: center; justify-content: space-between; }
.map-state { display: flex; align-items: center; gap: 6px; color: var(--text-faint); font-family: monospace; font-size: 9px; font-weight: 700; text-transform: uppercase; }
.map-state i { width: 6px; height: 6px; border-radius: 50%; background: var(--amber); }
.map-state.ready i { background: var(--accent); box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 65%, transparent); }
.map-state.error i { background: var(--danger); }
.map-state.disabled i { background: var(--text-faint); }
.readout-stats { display: grid; grid-template-columns: 1fr 1fr; margin-top: 15px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.readout-stats > div { display: flex; min-width: 0; flex-direction: column; padding: 10px; }
.readout-stats > div + div { border-left: 1px solid var(--border); }
.readout-stats strong { overflow: hidden; color: var(--text); font-family: monospace; font-size: 16px; text-overflow: ellipsis; }
.readout-stats span { margin-top: 2px; color: var(--text-faint); font-family: monospace; font-size: 8px; letter-spacing: .1em; text-transform: uppercase; }
.map-message { margin: 10px 0 0; color: var(--text-muted); font-size: 10px; line-height: 1.4; }
.map-message.error { color: var(--danger); }
.locate-button { display: flex; width: 100%; min-height: 44px; align-items: center; justify-content: center; gap: 7px; margin-top: 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); padding: 8px; color: var(--text); font-size: 10px; font-weight: 700; cursor: pointer; transition: border-color 140ms ease, color 140ms ease; }
.locate-button:hover { border-color: var(--cyan); color: var(--cyan); }
.map-legend { position: absolute; z-index: 1000; bottom: 22px; left: 22px; display: flex; flex-wrap: wrap; gap: 14px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface-1); padding: calc(10px * var(--space-unit)) 12px; }
.map-legend span { display: flex; align-items: center; gap: 6px; color: var(--text-muted); font-family: monospace; font-size: 9px; text-transform: uppercase; }
.map-legend i { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
.map-legend i.local { background: var(--cyan); }
.map-legend i.repeater { background: var(--amber); }
.map-legend i.room { background: var(--violet); }
:global(:root[data-theme="dark"] .map-canvas .leaflet-tile-pane) { filter: invert(.92) hue-rotate(155deg) saturate(.65) brightness(.68) contrast(1.08); }
:global(.mesh-cluster-wrap) { background: transparent; }
:global(.mesh-cluster) { display: grid; width: 38px; height: 38px; place-items: center; border: 2px solid var(--cluster-ring); border-radius: 50%; background: var(--cluster-bg); color: #fff; font-family: monospace; font-size: 11px; font-weight: 800; box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 18%, transparent); }
:global(.leaflet-control-zoom a) { display: grid; width: 44px; height: 44px; place-items: center; line-height: 1; }

@media (max-width: 720px) {
  .map-heading { top: 12px; left: 12px; width: auto; max-width: calc(100% - 24px); padding: 10px 13px; }
  .map-heading h1 { font-size: 20px; }
  .map-heading p { display: none; }
  .map-readout { top: auto; right: 12px; bottom: 58px; left: 12px; width: auto; padding: 11px; }
  .readout-heading, .map-message { display: none; }
  .map-readout { display: grid; grid-template-columns: 1.1fr .9fr; gap: 8px; }
  .readout-stats { width: auto; margin: 0; }
  .locate-button { width: auto; height: 44px; margin: 0; }
  .map-legend { right: 12px; bottom: 12px; left: 12px; justify-content: space-between; gap: 6px; padding: 8px 9px; }
  .map-legend span { font-size: 8px; }
}
</style>
