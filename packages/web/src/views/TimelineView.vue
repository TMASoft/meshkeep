<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ContactTelemetryPoint, RadioSummary, TimelineEvent, TimelineEventKind } from "@meshkeep/shared";
import { api } from "../api/client";
import { useAppStore, radioSuffix } from "../stores/app";
import AppIcon from "../components/AppIcon.vue";
import {
  KIND_META,
  clusterEvents,
  panBy,
  timeTicks,
  zoomAround,
  type TimeWindow,
  type TimelineCluster,
} from "../timeline";

const store = useAppStore();

const LANE_H = 84;
const AXIS_H = 30;
const LANE_PAD_TOP = 18;
const KIND_ROW_H = 12;
const BASE_KINDS: TimelineEventKind[] = ["advert", "message", "alert", "link"];
const SPAN_PRESETS = [
  { label: "1h", secs: 3600 },
  { label: "6h", secs: 6 * 3600 },
  { label: "24h", secs: 86_400 },
  { label: "7d", secs: 7 * 86_400 },
  { label: "30d", secs: 30 * 86_400 },
];

const nowSecs = () => Math.floor(Date.now() / 1000);

const phase = ref<"loading" | "ready" | "error">("loading");
const errorText = ref<string | null>(null);
const selectedRadioIds = ref<number[]>([]);
const view = ref<TimeWindow>({ start: nowSecs() - 6 * 3600, end: nowSecs() });
const showTelemetry = ref(false);
const events = ref<TimelineEvent[]>([]);
const truncated = ref(false);
// Keep following "now" (window slides forward) until the user pans/zooms away.
const follow = ref(true);
const widthPx = ref(800);
const canvasWrap = ref<HTMLElement | null>(null);
const popover = ref<{ cluster: TimelineCluster; radioId: number; x: number; y: number } | null>(null);
const advertTelemetry = ref<ContactTelemetryPoint | null>(null);

// Non-reactive per-instance state: the id-keyed event set the fetched window
// and live feed merge into, plus fetch bookkeeping and timers.
const eventsById = new Map<string, TimelineEvent>();
let fetched: { from: number; to: number; ids: string; kinds: string } | null = null;
let fetchTimer: ReturnType<typeof setTimeout> | null = null;
let followTimer: ReturnType<typeof setInterval> | null = null;
let resizeObserver: ResizeObserver | null = null;
let drag: { startX: number; view: TimeWindow; moved: boolean } | null = null;
// A click event still fires after a drag's pointerup; this suppresses it.
let suppressNextClick = false;
let fetchSeq = 0;

const enabledKinds = computed<TimelineEventKind[]>(() =>
  showTelemetry.value ? [...BASE_KINDS, "telemetry"] : BASE_KINDS,
);

const lanes = computed<RadioSummary[]>(() =>
  selectedRadioIds.value
    .map((id) => store.radios.find((radio) => radio.id === id))
    .filter((radio): radio is RadioSummary => radio !== undefined),
);

const svgHeight = computed(() => Math.max(lanes.value.length, 1) * LANE_H + AXIS_H);
const span = computed(() => view.value.end - view.value.start);

function x(ts: number): number {
  return ((ts - view.value.start) / span.value) * widthPx.value;
}

const ticks = computed(() => timeTicks(view.value.start, view.value.end, widthPx.value));
const nowX = computed(() => {
  const now = nowSecs();
  return now >= view.value.start && now <= view.value.end ? x(now) : null;
});

/** Per lane, per kind: the clustered dots inside the visible window. */
const laneClusters = computed(() => {
  return lanes.value.map((radio) => {
    const laneEvents = events.value.filter(
      (event) =>
        event.radioId === radio.id &&
        event.ts >= view.value.start &&
        event.ts <= view.value.end &&
        enabledKinds.value.includes(event.kind),
    );
    return enabledKinds.value.map((kind) =>
      clusterEvents(
        laneEvents.filter((event) => event.kind === kind),
        view.value,
        widthPx.value,
      ),
    );
  });
});

function radioLabel(radio: RadioSummary): string {
  return radio.name ?? (radio.publicKey ? radio.publicKey.slice(0, 8) : `Radio ${radio.id}`);
}

function radioIsLive(radio: RadioSummary): boolean {
  return store.links.some((link) => link.radioId === radio.id && link.connection.state === "connected");
}

function dotY(lane: number, kind: TimelineEventKind): number {
  return lane * LANE_H + LANE_PAD_TOP + KIND_META[kind].rowOffset * KIND_ROW_H;
}

function syncEvents(): void {
  events.value = [...eventsById.values()].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
}

async function loadEvents(): Promise<void> {
  const ids = selectedRadioIds.value;
  if (!ids.length) {
    eventsById.clear();
    syncEvents();
    phase.value = "ready";
    return;
  }
  // Fetch a window padded to 3× the visible span so small pans don't refetch.
  const padded = span.value;
  const from = Math.max(0, Math.floor(view.value.start - padded));
  const to = Math.ceil(view.value.end + padded);
  const idsKey = ids.join(",");
  const kindsKey = enabledKinds.value.join(",");
  const seq = ++fetchSeq;
  try {
    const res = await api<{ events: TimelineEvent[]; truncated: boolean }>(
      `/timeline?radioIds=${idsKey}&from=${from}&to=${to}&kinds=${kindsKey}&limit=2000`,
    );
    if (seq !== fetchSeq) return; // superseded by a newer request
    if (fetched === null || fetched.ids !== idsKey || fetched.kinds !== kindsKey) {
      eventsById.clear();
    } else {
      // Replace everything inside the fetched range with authoritative rows.
      // This also collapses `tlm:live:` synthetics into their persisted ids.
      for (const [id, event] of eventsById) {
        if (event.ts >= from && event.ts <= to) eventsById.delete(id);
      }
    }
    for (const event of res.events) eventsById.set(event.id, event);
    fetched = { from, to, ids: idsKey, kinds: kindsKey };
    truncated.value = res.truncated;
    syncEvents();
    phase.value = "ready";
    errorText.value = null;
  } catch (error) {
    if (seq !== fetchSeq) return;
    errorText.value = error instanceof Error ? error.message : "Failed to load the timeline";
    phase.value = "error";
  }
}

function scheduleFetch(): void {
  if (fetchTimer) clearTimeout(fetchTimer);
  fetchTimer = setTimeout(() => {
    fetchTimer = null;
    const idsKey = selectedRadioIds.value.join(",");
    const kindsKey = enabledKinds.value.join(",");
    const escaped =
      fetched === null ||
      fetched.ids !== idsKey ||
      fetched.kinds !== kindsKey ||
      view.value.start < fetched.from ||
      view.value.end > fetched.to;
    if (escaped) void loadEvents();
  }, 250);
}

watch([() => view.value.start, () => view.value.end, showTelemetry], scheduleFetch);
watch(
  selectedRadioIds,
  () => {
    popover.value = null;
    scheduleFetch();
  },
  { deep: true },
);

// Live events land in the store's cross-radio feed; merge the ones for the
// radios and kinds on screen. The feed is small (capped), so a full pass is fine.
watch(
  () => store.timelineSeq,
  () => {
    let added = false;
    for (const event of store.timelineFeed) {
      if (!selectedRadioIds.value.includes(event.radioId)) continue;
      if (!enabledKinds.value.includes(event.kind)) continue;
      if (!eventsById.has(event.id)) {
        eventsById.set(event.id, event);
        added = true;
      }
    }
    if (added) {
      syncEvents();
      if (follow.value) slideToNow();
    }
  },
);

function slideToNow(): void {
  const now = nowSecs();
  if (view.value.end < now) view.value = { start: now - span.value, end: now };
}

// ---- interaction ----

function setView(next: TimeWindow, keepFollow = false): void {
  view.value = next;
  if (!keepFollow) follow.value = next.end >= nowSecs() - 30;
}

function onWheel(event: WheelEvent): void {
  const factor = event.deltaY > 0 ? 1.25 : 0.8;
  // offsetX is relative to whichever SVG child is under the cursor; measure
  // against the canvas itself so the anchor is always the true cursor position.
  const rect = (event.currentTarget as Element).getBoundingClientRect();
  const anchorTs = view.value.start + ((event.clientX - rect.left) / widthPx.value) * span.value;
  setView(zoomAround(view.value, anchorTs, factor, nowSecs()));
}

function zoomCentered(factor: number): void {
  const anchorTs = view.value.start + span.value / 2;
  setView(zoomAround(view.value, anchorTs, factor, nowSecs()));
}

function setSpanPreset(secs: number): void {
  const end = follow.value ? nowSecs() : view.value.end;
  setView({ start: end - secs, end }, follow.value);
}

function jumpToNow(): void {
  const now = nowSecs();
  view.value = { start: now - span.value, end: now };
  follow.value = true;
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  drag = { startX: event.clientX, view: { ...view.value }, moved: false };
}

function onPointerMove(event: PointerEvent): void {
  if (!drag) return;
  const dxPx = event.clientX - drag.startX;
  if (!drag.moved && Math.abs(dxPx) > 3) {
    drag.moved = true;
    // Capture only once a real drag starts. Capturing on pointerdown would
    // retarget the follow-up click to the canvas, so dots never receive it.
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
  }
  if (!drag.moved) return;
  const deltaSecs = (-dxPx / widthPx.value) * (drag.view.end - drag.view.start);
  const panned = panBy(drag.view, deltaSecs, nowSecs());
  view.value = panned;
  follow.value = false;
}

function onPointerUp(): void {
  suppressNextClick = drag?.moved ?? false;
  drag = null;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "+" || event.key === "=") zoomCentered(0.8);
  else if (event.key === "-") zoomCentered(1.25);
  else if (event.key === "ArrowLeft") setView(panBy(view.value, -span.value * 0.1, nowSecs()));
  else if (event.key === "ArrowRight") setView(panBy(view.value, span.value * 0.1, nowSecs()));
  else if (event.key === "Escape") popover.value = null;
  else return;
  event.preventDefault();
}

// ---- popover ----

function openPopover(cluster: TimelineCluster, laneIndex: number, radioId: number): void {
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  const px = Math.min(Math.max(x(cluster.ts), 130), Math.max(widthPx.value - 130, 130));
  popover.value = { cluster, radioId, x: px, y: laneIndex * LANE_H + LANE_PAD_TOP };
  advertTelemetry.value = null;
  const first = cluster.events[0];
  if (cluster.events.length === 1 && first.kind === "advert") {
    void api<{ points: ContactTelemetryPoint[] }>(
      `/contacts/${first.advert.contactKey}/telemetry/history?hours=168${radioSuffix(radioId, "&")}`,
    )
      .then((res) => {
        advertTelemetry.value = res.points.length ? res.points[res.points.length - 1] : null;
      })
      .catch(() => {});
  }
}

function zoomToCluster(cluster: TimelineCluster): void {
  const first = cluster.events[0].ts;
  const last = cluster.events[cluster.events.length - 1].ts;
  const extent = Math.max(last - first, 60);
  setView({ start: first - extent, end: last + extent });
  popover.value = null;
}

function handleOutsidePointer(event: PointerEvent): void {
  if (!popover.value) return;
  const target = event.target as Element;
  if (target.closest(".event-popover") || target.closest(".event-dot")) return;
  popover.value = null;
}

// ---- radio selection ----

function toggleRadio(id: number): void {
  selectedRadioIds.value = selectedRadioIds.value.includes(id)
    ? selectedRadioIds.value.filter((other) => other !== id)
    : [...selectedRadioIds.value, id];
}

watch(
  () => store.radios,
  (radios) => {
    // Default to the radio already in view once the radio list arrives.
    if (!selectedRadioIds.value.length && radios.length) {
      const preferred = store.effectiveRadioId ?? radios[0].id;
      selectedRadioIds.value = [preferred];
      void loadEvents();
    }
  },
  { immediate: true },
);

// A server with no stored radios has nothing to load — don't spin forever.
watch(
  () => store.bootstrapPhase,
  (bootstrapPhase) => {
    if (bootstrapPhase === "ready" && !store.radios.length) phase.value = "ready";
  },
  { immediate: true },
);

// ---- formatting ----

function fmtTs(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

function eventTitle(event: TimelineEvent): string {
  switch (event.kind) {
    case "advert":
      return `Advert · ${event.advert.name || event.advert.contactKey.slice(0, 8)}`;
    case "message": {
      const who =
        event.message.messageKind === "channel"
          ? event.message.channelName ?? `Channel ${event.message.channelIdx}`
          : event.message.contactName ?? event.message.contactPrefix ?? event.message.contactKey?.slice(0, 8) ?? "Unknown";
      return `${event.message.direction === "in" ? "Message from" : "Message to"} ${who}`;
    }
    case "alert":
      return `${event.alert.direction === "breach" ? "Alert" : "Recovered"} · ${event.alert.label}`;
    case "link":
      return event.link.state === "connected" ? "Radio connected" : "Radio disconnected";
    case "telemetry":
      return event.telemetry.contactKey
        ? `Telemetry · ${event.telemetry.contactName ?? event.telemetry.contactKey.slice(0, 8)}`
        : "Battery sample";
  }
}

function fmtReadingValue(value: number | Record<string, number>): string {
  return typeof value === "number" ? String(value) : Object.entries(value).map(([k, v]) => `${k} ${v}`).join(", ");
}

// ---- lifecycle ----

onMounted(() => {
  resizeObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width;
    if (width) widthPx.value = width;
  });
  if (canvasWrap.value) {
    resizeObserver.observe(canvasWrap.value);
    widthPx.value = canvasWrap.value.clientWidth || widthPx.value;
  }
  followTimer = setInterval(() => {
    if (follow.value) slideToNow();
  }, 30_000);
  document.addEventListener("pointerdown", handleOutsidePointer);
  if (selectedRadioIds.value.length) void loadEvents();
  else if (store.radios.length === 0 && store.bootstrapPhase === "ready") phase.value = "ready";
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  if (followTimer) clearInterval(followTimer);
  if (fetchTimer) clearTimeout(fetchTimer);
  document.removeEventListener("pointerdown", handleOutsidePointer);
});
</script>

<template>
  <div class="timeline-view">
    <header class="page-heading">
      <div>
        <span class="instrument-label">Radio event history</span>
        <h1>Timeline</h1>
        <p>Everything each radio has seen — adverts, messages, alerts, link changes — plotted over time. Scroll to zoom, drag to pan, click a dot for details.</p>
      </div>
      <div class="heading-actions">
        <button type="button" class="button secondary" :disabled="phase === 'loading'" @click="loadEvents">
          <AppIcon name="pulse" :size="15" />
          Refresh
        </button>
      </div>
    </header>

    <div class="timeline-body">
      <section class="module controls-module">
        <div class="controls-row" role="group" aria-label="Radios on the timeline">
          <span class="controls-label">Radios</span>
          <button
            v-for="radio in store.radios"
            :key="radio.id"
            type="button"
            class="chip"
            :class="{ active: selectedRadioIds.includes(radio.id) }"
            @click="toggleRadio(radio.id)"
          >
            <span v-if="radioIsLive(radio)" class="live-dot" aria-label="connected" />
            {{ radioLabel(radio) }}
          </button>
          <span v-if="!store.radios.length" class="controls-empty">No radios have connected yet.</span>
        </div>
        <div class="controls-row">
          <span class="controls-label">Window</span>
          <button
            v-for="preset in SPAN_PRESETS"
            :key="preset.label"
            type="button"
            class="chip"
            :class="{ active: Math.abs(span - preset.secs) < preset.secs * 0.05 }"
            @click="setSpanPreset(preset.secs)"
          >
            {{ preset.label }}
          </button>
          <span class="controls-divider" aria-hidden="true" />
          <button type="button" class="chip" aria-label="Zoom in" @click="zoomCentered(0.8)">＋</button>
          <button type="button" class="chip" aria-label="Zoom out" @click="zoomCentered(1.25)">－</button>
          <button type="button" class="chip" :class="{ active: follow }" @click="jumpToNow">Now</button>
          <span class="controls-divider" aria-hidden="true" />
          <label class="toggle">
            <input v-model="showTelemetry" type="checkbox" />
            Telemetry samples
          </label>
        </div>
        <div class="legend" aria-hidden="true">
          <span v-for="kind in enabledKinds" :key="kind" class="legend-item">
            <span class="legend-dot" :style="{ background: `var(${KIND_META[kind].cssVar})` }" />
            {{ KIND_META[kind].label }}
          </span>
        </div>
      </section>

      <div v-if="phase === 'loading'" class="timeline-state">
        <span class="spinner" aria-hidden="true" />
        <p>Loading events…</p>
      </div>

      <div v-else-if="phase === 'error'" class="timeline-state" role="alert">
        <AppIcon name="alert" :size="26" />
        <p>{{ errorText }}</p>
        <button type="button" class="button secondary" @click="loadEvents">Retry</button>
      </div>

      <section v-else class="module canvas-module">
        <p v-if="truncated" class="truncated-note" role="status">
          Showing the first 2000 events in this window — zoom in to see everything.
        </p>
        <div v-if="!lanes.length" class="timeline-state">
          <p>Select a radio above to see its timeline.</p>
        </div>
        <div v-else ref="canvasWrap" class="canvas-wrap">
          <div class="lane-labels" aria-hidden="true">
            <span
              v-for="(radio, laneIndex) in lanes"
              :key="radio.id"
              class="lane-label"
              :style="{ top: `${laneIndex * LANE_H + 6}px` }"
            >
              {{ radioLabel(radio) }}
            </span>
          </div>
          <svg
            class="canvas"
            :width="widthPx"
            :height="svgHeight"
            tabindex="0"
            role="application"
            aria-label="Radio event timeline. Use plus and minus to zoom, arrow keys to pan."
            @wheel.prevent="onWheel"
            @pointerdown="onPointerDown"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
            @keydown="onKeydown"
          >
            <!-- lane backgrounds -->
            <rect
              v-for="(radio, laneIndex) in lanes"
              :key="`bg-${radio.id}`"
              x="0"
              :y="laneIndex * LANE_H"
              :width="widthPx"
              :height="LANE_H"
              :class="laneIndex % 2 ? 'lane-bg alt' : 'lane-bg'"
            />
            <!-- time ticks -->
            <g v-for="tick in ticks" :key="tick.ts">
              <line :x1="x(tick.ts)" :x2="x(tick.ts)" y1="0" :y2="svgHeight - AXIS_H" :class="tick.major ? 'tick major' : 'tick'" />
              <text :x="x(tick.ts) + 4" :y="svgHeight - 10" class="tick-label">{{ tick.label }}</text>
            </g>
            <!-- now marker -->
            <line v-if="nowX !== null" :x1="nowX" :x2="nowX" y1="0" :y2="svgHeight - AXIS_H" class="now-line" />
            <!-- events -->
            <g v-for="(kindGroups, laneIndex) in laneClusters" :key="`lane-${lanes[laneIndex].id}`">
              <g v-for="(clusters, kindIndex) in kindGroups" :key="enabledKinds[kindIndex]">
                <g
                  v-for="cluster in clusters"
                  :key="cluster.events[0].id"
                  class="event-dot"
                  role="button"
                  :aria-label="`${cluster.events.length} ${KIND_META[cluster.kind].label} events`"
                  @click.stop="openPopover(cluster, laneIndex, lanes[laneIndex].id)"
                >
                  <circle
                    :cx="x(cluster.ts)"
                    :cy="dotY(laneIndex, cluster.kind)"
                    :r="cluster.events.length > 1 ? 6 : 4.5"
                    :style="{ fill: `var(${KIND_META[cluster.kind].cssVar})` }"
                  />
                  <text
                    v-if="cluster.events.length > 1"
                    :x="x(cluster.ts) + 8"
                    :y="dotY(laneIndex, cluster.kind) + 3.5"
                    class="cluster-badge"
                  >
                    ×{{ cluster.events.length }}
                  </text>
                </g>
              </g>
            </g>
          </svg>

          <div
            v-if="popover"
            class="event-popover"
            :style="{ left: `${popover.x}px`, top: `${popover.y + 16}px` }"
            role="dialog"
            aria-label="Event details"
          >
            <button type="button" class="popover-close" aria-label="Close" @click="popover = null">
              <AppIcon name="close" :size="13" />
            </button>

            <template v-if="popover.cluster.events.length === 1">
              <template v-for="event in popover.cluster.events" :key="event.id">
                <strong class="popover-title">{{ eventTitle(event) }}</strong>
                <time class="popover-time">{{ fmtTs(event.ts) }}</time>
                <dl v-if="event.kind === 'advert'" class="popover-spec">
                  <div><dt>Node</dt><dd>{{ event.advert.name || "—" }}</dd></div>
                  <div><dt>Type</dt><dd class="capitalize">{{ event.advert.type }}</dd></div>
                  <div><dt>Key</dt><dd>{{ event.advert.contactKey.slice(0, 16) }}…</dd></div>
                  <div><dt>Heard as</dt><dd>{{ event.advert.observed === "new" ? "full advert" : "advert ping" }}</dd></div>
                  <div v-if="event.advert.lat !== null && event.advert.lon !== null">
                    <dt>Location</dt><dd>{{ event.advert.lat!.toFixed(4) }}, {{ event.advert.lon!.toFixed(4) }}</dd>
                  </div>
                  <div v-if="event.advert.outPathLen >= 0"><dt>Path length</dt><dd>{{ event.advert.outPathLen }}</dd></div>
                  <template v-if="advertTelemetry">
                    <div class="popover-subhead"><dt>Latest telemetry</dt><dd>{{ fmtTs(advertTelemetry.ts) }}</dd></div>
                    <div v-for="reading in advertTelemetry.readings.slice(0, 6)" :key="`${reading.channel}:${reading.type}`">
                      <dt>{{ reading.label }}</dt>
                      <dd>{{ fmtReadingValue(reading.value) }}{{ reading.unit ? ` ${reading.unit}` : "" }}</dd>
                    </div>
                  </template>
                </dl>
                <dl v-else-if="event.kind === 'message'" class="popover-spec">
                  <div><dt>Direction</dt><dd>{{ event.message.direction === "in" ? "received" : "sent" }}</dd></div>
                  <div>
                    <dt>{{ event.message.messageKind === "channel" ? "Channel" : "Contact" }}</dt>
                    <dd>{{ event.message.messageKind === "channel"
                      ? event.message.channelName ?? `#${event.message.channelIdx}`
                      : event.message.contactName ?? event.message.contactPrefix ?? "Unknown" }}</dd>
                  </div>
                  <div><dt>Sender time</dt><dd>{{ fmtTs(event.message.senderTimestamp) }}</dd></div>
                  <div class="popover-text"><dd>{{ event.message.preview }}</dd></div>
                </dl>
                <dl v-else-if="event.kind === 'alert'" class="popover-spec">
                  <div><dt>Metric</dt><dd>{{ event.alert.label }}</dd></div>
                  <div v-if="event.alert.contactName"><dt>Contact</dt><dd>{{ event.alert.contactName }}</dd></div>
                  <div>
                    <dt>Value</dt>
                    <dd>{{ event.alert.value }} ({{ event.alert.comparator }} {{ event.alert.threshold }})</dd>
                  </div>
                  <div><dt>Transition</dt><dd>{{ event.alert.direction }}</dd></div>
                </dl>
                <dl v-else-if="event.kind === 'link'" class="popover-spec">
                  <div><dt>State</dt><dd>{{ event.link.state }}</dd></div>
                  <div><dt>Transport</dt><dd>{{ event.link.transport }}</dd></div>
                  <div><dt>Link</dt><dd>{{ event.link.label }}</dd></div>
                  <div v-if="event.link.error"><dt>Reason</dt><dd class="warn">{{ event.link.error }}</dd></div>
                </dl>
                <dl v-else-if="event.kind === 'telemetry'" class="popover-spec">
                  <div v-if="event.telemetry.batteryMv !== null">
                    <dt>Battery</dt><dd>{{ event.telemetry.batteryMv }} mV</dd>
                  </div>
                  <div v-for="reading in event.telemetry.readings.slice(0, 6)" :key="`${reading.channel}:${reading.type}`">
                    <dt>{{ reading.label }}</dt>
                    <dd>{{ fmtReadingValue(reading.value) }}{{ reading.unit ? ` ${reading.unit}` : "" }}</dd>
                  </div>
                </dl>
              </template>
            </template>

            <template v-else>
              <strong class="popover-title">{{ popover.cluster.events.length }} {{ KIND_META[popover.cluster.kind].label.toLowerCase() }} events</strong>
              <time class="popover-time">
                {{ fmtTs(popover.cluster.events[0].ts) }} – {{ fmtTs(popover.cluster.events[popover.cluster.events.length - 1].ts) }}
              </time>
              <ul class="popover-list">
                <li v-for="event in popover.cluster.events.slice(0, 20)" :key="event.id">
                  <span>{{ eventTitle(event) }}</span>
                  <time>{{ fmtTs(event.ts) }}</time>
                </li>
                <li v-if="popover.cluster.events.length > 20" class="popover-more">
                  …and {{ popover.cluster.events.length - 20 }} more
                </li>
              </ul>
              <button type="button" class="button secondary popover-zoom" @click="zoomToCluster(popover.cluster)">
                Zoom to these
              </button>
            </template>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.timeline-view { height: 100%; overflow-y: auto; background: var(--bg); padding: calc(28px * var(--space-unit)) clamp(16px, 3vw, 44px) 48px; }
.page-heading { display: flex; width: min(1180px, 100%); align-items: flex-end; justify-content: space-between; gap: 16px; margin: 0 auto calc(24px * var(--space-unit)); }
.page-heading h1 { margin: 4px 0 4px; font-size: clamp(28px, 4vw, 40px); font-weight: 740; letter-spacing: -.045em; }
.page-heading p { margin: 0; max-width: 60ch; color: var(--text-muted); font-size: 12px; }
.instrument-label { color: var(--text-faint); font-family: monospace; font-size: 9px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
.heading-actions { display: flex; flex-shrink: 0; gap: 8px; }
.button { display: inline-flex; min-height: 44px; align-items: center; justify-content: center; gap: 7px; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0 15px; font-size: 11px; font-weight: 750; text-decoration: none; cursor: pointer; transition: border-color 140ms ease, background 140ms ease, transform 140ms ease; }
.button:hover:not(:disabled) { transform: translateY(-1px); }
.button:disabled { opacity: .45; cursor: not-allowed; }
.button.secondary { background: var(--surface-2); color: var(--text); }
.button.secondary:hover:not(:disabled) { border-color: var(--cyan); color: var(--cyan); }
.timeline-body { display: flex; width: min(1180px, 100%); flex-direction: column; gap: 16px; margin: 0 auto; }
.module { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface-1); overflow: hidden; }
.controls-module { display: flex; flex-direction: column; gap: 10px; padding: 14px 18px; overflow: visible; }
.controls-row { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
.controls-label { min-width: 52px; color: var(--text-faint); font-family: monospace; font-size: 9px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
.controls-empty { color: var(--text-muted); font-size: 12px; }
.controls-divider { width: 1px; height: 20px; background: var(--border); }
.chip { display: inline-flex; min-height: 30px; align-items: center; gap: 6px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface-2); padding: 0 12px; color: var(--text-muted); font-size: 11px; font-weight: 700; cursor: pointer; transition: border-color 140ms ease, color 140ms ease, background 140ms ease; }
.chip:hover { border-color: var(--cyan); color: var(--cyan); }
.chip.active { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, var(--surface-2)); color: var(--text); }
.live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
.toggle { display: inline-flex; align-items: center; gap: 7px; color: var(--text-muted); font-size: 11px; font-weight: 700; cursor: pointer; }
.toggle input { accent-color: var(--accent); }
.legend { display: flex; flex-wrap: wrap; gap: 14px; }
.legend-item { display: inline-flex; align-items: center; gap: 6px; color: var(--text-faint); font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.legend-dot { width: 8px; height: 8px; border-radius: 50%; }
.canvas-module { position: relative; }
.truncated-note { margin: 0; border-bottom: 1px solid color-mix(in srgb, var(--amber) 35%, var(--border)); background: color-mix(in srgb, var(--amber) 9%, var(--surface-1)); padding: 9px 18px; color: var(--amber); font-size: 11px; }
.canvas-wrap { position: relative; width: 100%; overflow: hidden; }
.canvas { display: block; touch-action: pan-y; cursor: grab; outline: none; }
.canvas:active { cursor: grabbing; }
.canvas:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); }
.lane-labels { position: absolute; inset: 0; z-index: 1; pointer-events: none; }
.lane-label { position: absolute; left: 10px; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--surface-1) 80%, transparent); padding: 2px 7px; color: var(--text-muted); font-family: monospace; font-size: 10px; font-weight: 800; letter-spacing: .08em; }
.lane-bg { fill: transparent; }
.lane-bg.alt { fill: color-mix(in srgb, var(--surface-2) 55%, transparent); }
.tick { stroke: color-mix(in srgb, var(--border) 60%, transparent); }
.tick.major { stroke: var(--border-strong); }
.tick-label { fill: var(--text-faint); font-family: monospace; font-size: 9.5px; }
.now-line { stroke: var(--accent); stroke-dasharray: 3 3; }
.event-dot { cursor: pointer; }
.event-dot circle { stroke: var(--bg); stroke-width: 1.5; transition: r 120ms ease; }
.event-dot:hover circle { stroke: var(--text); }
.cluster-badge { fill: var(--text-muted); font-family: monospace; font-size: 9.5px; font-weight: 700; pointer-events: none; }
.event-popover { position: absolute; z-index: 5; width: min(280px, 84vw); transform: translateX(-50%); border: 1px solid var(--border-strong); border-radius: var(--radius-md); background: var(--surface-raised); box-shadow: var(--shadow); padding: 12px 14px; }
.popover-close { position: absolute; top: 8px; right: 8px; display: inline-flex; border: 0; background: none; padding: 4px; color: var(--text-faint); cursor: pointer; }
.popover-close:hover { color: var(--text); }
.popover-title { display: block; padding-right: 22px; color: var(--text); font-size: 12px; font-weight: 720; }
.popover-time { display: block; margin-top: 2px; color: var(--text-faint); font-family: monospace; font-size: 10px; }
.popover-spec { display: grid; margin: 8px 0 0; }
.popover-spec > div { display: flex; justify-content: space-between; gap: 12px; border-top: 1px solid color-mix(in srgb, var(--border) 55%, transparent); padding: 5px 0; }
.popover-spec dt { color: var(--text-faint); font-size: 10.5px; font-weight: 600; }
.popover-spec dd { margin: 0; color: var(--text); font-family: monospace; font-size: 11px; text-align: right; overflow-wrap: anywhere; }
.popover-spec dd.warn { color: var(--amber); }
.popover-spec .popover-subhead dt { color: var(--text-muted); font-weight: 800; }
.popover-text dd { text-align: left; font-family: inherit; font-size: 11.5px; line-height: 1.45; color: var(--text-muted); }
.popover-list { margin: 8px 0 0; max-height: 220px; overflow-y: auto; padding: 0; list-style: none; }
.popover-list li { display: flex; justify-content: space-between; gap: 10px; border-top: 1px solid color-mix(in srgb, var(--border) 55%, transparent); padding: 5px 0; font-size: 11px; }
.popover-list li span { color: var(--text); overflow-wrap: anywhere; }
.popover-list li time { flex-shrink: 0; color: var(--text-faint); font-family: monospace; font-size: 10px; }
.popover-more { color: var(--text-faint); }
.popover-zoom { margin-top: 10px; width: 100%; min-height: 34px; }
.capitalize { text-transform: capitalize; }
.timeline-state { display: flex; min-height: 220px; flex-direction: column; align-items: center; justify-content: center; gap: 14px; color: var(--text-muted); text-align: center; }
.spinner { width: 26px; height: 26px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: timeline-spin 700ms linear infinite; }
@keyframes timeline-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.4s; } }
@media (max-width: 720px) {
  .page-heading { flex-direction: column; align-items: flex-start; }
  .controls-label { min-width: 100%; }
}
</style>
