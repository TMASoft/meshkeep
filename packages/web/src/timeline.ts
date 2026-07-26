import type { TimelineEvent, TimelineEventKind, WsEvent } from "@meshkeep/shared";

/** Visible time window of the timeline canvas, epoch seconds. */
export interface TimeWindow {
  start: number;
  end: number;
}

/** Zoom bounds: 5 minutes fully zoomed in, 90 days fully zoomed out. */
export const MIN_SPAN = 300;
export const MAX_SPAN = 90 * 86_400;
/** How far past "now" the window may extend (fraction of the span). */
const FUTURE_HEADROOM = 0.05;

export const TIMELINE_KINDS: TimelineEventKind[] = ["advert", "message", "alert", "link", "telemetry"];

/** Per-kind presentation: label, color token, and vertical sub-row in a lane. */
export const KIND_META: Record<TimelineEventKind, { label: string; cssVar: string; rowOffset: number }> = {
  link: { label: "Link", cssVar: "--text-muted", rowOffset: 0 },
  advert: { label: "Advert", cssVar: "--accent", rowOffset: 1 },
  message: { label: "Message", cssVar: "--cyan", rowOffset: 2 },
  alert: { label: "Alert", cssVar: "--danger", rowOffset: 3 },
  telemetry: { label: "Telemetry", cssVar: "--violet", rowOffset: 4 },
};

/**
 * Map a live WS event onto a timeline entry, or null when it carries none.
 * Adverts and link transitions arrive pre-built as `timeline.event`; message,
 * alert, and battery-telemetry entries are synthesized from the events those
 * features already push. Live battery samples have no row id yet, so they get
 * a synthetic `tlm:live:` id; a later refetch replaces them with stored rows.
 */
export function wsToTimelineEvent(event: WsEvent): TimelineEvent | null {
  switch (event.type) {
    case "timeline.event":
      return event.event;
    case "message.new":
      return {
        id: `msg:${event.message.id}`,
        radioId: event.radioId,
        ts: event.message.createdAt,
        kind: "message",
        message: {
          messageId: event.message.id,
          messageKind: event.message.kind,
          direction: event.message.direction,
          contactKey: event.message.contactKey,
          contactPrefix: event.message.contactPrefix ?? null,
          contactName: event.message.contactName ?? null,
          channelIdx: event.message.channelIdx,
          channelName: event.message.channelName ?? null,
          senderTimestamp: event.message.senderTimestamp,
          preview: event.message.text.slice(0, 140),
        },
      };
    case "telemetry.alert":
      return { id: `alr:${event.event.id}`, radioId: event.radioId, ts: event.event.ts, kind: "alert", alert: event.event };
    case "telemetry":
      return {
        id: `tlm:live:${event.radioId}:${event.ts}`,
        radioId: event.radioId,
        ts: event.ts,
        kind: "telemetry",
        telemetry: { contactKey: null, contactName: null, batteryMv: event.batteryMilliVolts, readings: [] },
      };
    default:
      return null;
  }
}

function clampWindow(start: number, end: number, now: number): TimeWindow {
  let span = Math.min(Math.max(end - start, MIN_SPAN), MAX_SPAN);
  let clampedEnd = end;
  const maxEnd = now + span * FUTURE_HEADROOM;
  if (clampedEnd > maxEnd) clampedEnd = maxEnd;
  return { start: clampedEnd - span, end: clampedEnd };
}

/**
 * Zoom the window by `factor` (>1 zooms out) keeping `anchorTs` at the same
 * fractional position, so the time under the cursor stays under the cursor.
 */
export function zoomAround(view: TimeWindow, anchorTs: number, factor: number, now: number): TimeWindow {
  const span = view.end - view.start;
  const newSpan = Math.min(Math.max(span * factor, MIN_SPAN), MAX_SPAN);
  const fraction = span > 0 ? (anchorTs - view.start) / span : 0.5;
  const start = anchorTs - fraction * newSpan;
  return clampWindow(start, start + newSpan, now);
}

export function panBy(view: TimeWindow, deltaSecs: number, now: number): TimeWindow {
  return clampWindow(view.start + deltaSecs, view.end + deltaSecs, now);
}

/** Tick steps from 1 minute to 30 days; the ladder picks the first step wide enough. */
const TICK_STEPS = [60, 300, 900, 3600, 10_800, 21_600, 43_200, 86_400, 172_800, 604_800, 1_209_600, 2_592_000];
const TARGET_TICK_PX = 80;

export interface TimeTick {
  ts: number;
  label: string;
  /** Day boundaries get a stronger line and a date label. */
  major: boolean;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Evenly spaced "nice" ticks for the visible window, aligned to local time. */
export function timeTicks(start: number, end: number, widthPx: number): TimeTick[] {
  const span = end - start;
  if (span <= 0 || widthPx <= 0) return [];
  const maxTicks = Math.max(2, Math.floor(widthPx / TARGET_TICK_PX));
  const step = TICK_STEPS.find((s) => span / s <= maxTicks) ?? TICK_STEPS[TICK_STEPS.length - 1];
  // Align to local midnight-relative boundaries so day ticks land on midnight
  // and hour ticks on the hour regardless of timezone offset.
  const offset = new Date(start * 1000).getTimezoneOffset() * 60;
  const first = Math.ceil((start - offset) / step) * step + offset;
  const ticks: TimeTick[] = [];
  for (let ts = first; ts <= end; ts += step) {
    const date = new Date(ts * 1000);
    const isMidnight = date.getHours() === 0 && date.getMinutes() === 0;
    const label =
      step >= 86_400 || isMidnight
        ? `${date.getMonth() + 1}/${date.getDate()}`
        : `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    ticks.push({ ts, label, major: step >= 86_400 || isMidnight });
  }
  return ticks;
}

export interface TimelineCluster {
  /** Representative timestamp (of the first event). */
  ts: number;
  kind: TimelineEventKind;
  events: TimelineEvent[];
}

/**
 * Group events (one lane, one kind, assumed sorted by ts) whose dots would
 * land within `minGapPx` of each other, so dense periods render as one "×N"
 * badge instead of an unreadable smear.
 */
export function clusterEvents(
  events: TimelineEvent[],
  view: TimeWindow,
  widthPx: number,
  minGapPx = 10,
): TimelineCluster[] {
  const span = view.end - view.start;
  if (span <= 0 || widthPx <= 0) return [];
  const minGapSecs = (minGapPx / widthPx) * span;
  const clusters: TimelineCluster[] = [];
  for (const event of events) {
    const current = clusters[clusters.length - 1];
    const last = current?.events[current.events.length - 1];
    if (current && last && event.kind === current.kind && event.ts - last.ts <= minGapSecs) {
      current.events.push(event);
    } else {
      clusters.push({ ts: event.ts, kind: event.kind, events: [event] });
    }
  }
  return clusters;
}
