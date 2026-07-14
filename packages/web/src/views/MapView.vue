<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import L from "leaflet";
import "leaflet.markercluster";
import { api } from "../api/client";
import { useAppStore } from "../stores/app";

const store = useAppStore();
const mapEl = ref<HTMLElement | null>(null);
const status = ref<"loading" | "ready" | "error" | "disabled">("loading");
const errorText = ref("");
const globalCount = ref(0);

let map: L.Map | null = null;

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
  const t = type.toLowerCase();
  if (t.includes("repeater") || t === "2") return "#f59e0b";
  if (t.includes("room") || t === "3") return "#8b5cf6";
  return "#10b981";
}

function circleMarker(lat: number, lon: number, color: string, radius = 6) {
  return L.circleMarker([lat, lon], {
    radius,
    color,
    weight: 1.5,
    fillColor: color,
    fillOpacity: 0.6,
  });
}

onMounted(async () => {
  if (!mapEl.value) return;
  map = L.map(mapEl.value, { zoomControl: true }).setView([30, 0], 2);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  // local overlay: our own node + contacts with known positions
  const localLayer = L.layerGroup().addTo(map);
  const localSpots: Array<[number, number]> = [];
  const self = store.self;
  if (self?.lat && self.lon) {
    circleMarker(self.lat, self.lon, "#0ea5e9", 9)
      .bindPopup(`<b>${self.name}</b><br>this node`)
      .addTo(localLayer);
    localSpots.push([self.lat, self.lon]);
  }
  for (const contact of store.contacts) {
    if (contact.lat && contact.lon) {
      circleMarker(contact.lat, contact.lon, "#0ea5e9", 7)
        .bindPopup(`<b>${contact.name}</b><br>${contact.type} · local contact`)
        .addTo(localLayer);
      localSpots.push([contact.lat, contact.lon]);
    }
  }

  // global layer from the cached map.meshcore.io proxy
  try {
    const { nodes: payload } = await api<{ nodes: unknown }>("/map/nodes");
    const nodes = normalizeNodes(payload);
    globalCount.value = nodes.length;
    const cluster = L.markerClusterGroup({
      chunkedLoading: true,
      iconCreateFunction: (clusterMarker) =>
        L.divIcon({
          html: `<div style="background:#10b981cc;color:#fff;border-radius:9999px;width:34px;height:34px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600">${clusterMarker.getChildCount()}</div>`,
          className: "",
          iconSize: [34, 34],
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
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to load map data";
    if (message.includes("disabled")) {
      status.value = "disabled";
    } else {
      status.value = "error";
      errorText.value = message;
    }
  }

  if (localSpots.length) {
    map.fitBounds(L.latLngBounds(localSpots).pad(0.5), { maxZoom: 11 });
  }
});

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

onBeforeUnmount(() => {
  map?.remove();
  map = null;
});
</script>

<template>
  <div class="relative h-full">
    <div ref="mapEl" class="h-full w-full" />
    <div
      class="absolute right-3 top-3 z-[1000] rounded-lg bg-white/90 px-3 py-2 text-xs shadow dark:bg-slate-900/90"
    >
      <div class="flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-full" style="background:#0ea5e9" /> local mesh</div>
      <div class="flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-full" style="background:#10b981" /> chat node</div>
      <div class="flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-full" style="background:#f59e0b" /> repeater</div>
      <div class="flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-full" style="background:#8b5cf6" /> room server</div>
      <div v-if="status === 'ready'" class="mt-1 text-slate-500">{{ globalCount.toLocaleString() }} global nodes</div>
      <div v-else-if="status === 'loading'" class="mt-1 text-slate-500">loading global nodes…</div>
      <div v-else-if="status === 'disabled'" class="mt-1 text-slate-500">global map disabled</div>
      <div v-else class="mt-1 text-rose-500">{{ errorText }}</div>
    </div>
  </div>
</template>
