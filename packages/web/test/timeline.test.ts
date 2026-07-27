import { describe, expect, it } from "vitest";
import type { Message, TimelineEvent, WsEvent } from "@meshkeep/shared";
import {
  AXIS_H,
  MAX_SPAN,
  MIN_LANE_H,
  MIN_SPAN,
  centerOn,
  clusterEvents,
  laneMetrics,
  overviewDomain,
  panBy,
  timeTicks,
  wsToTimelineEvent,
  zoomAround,
} from "../src/timeline";

const NOW = 1_800_000_000;

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 7,
    kind: "dm",
    contactKey: "a".repeat(64),
    channelIdx: null,
    direction: "in",
    text: "hello out there",
    senderTimestamp: NOW - 5,
    pathLen: null,
    status: "sent",
    createdAt: NOW,
    ...overrides,
  };
}

function advertEvent(ts: number, id = `adv:${ts}`): TimelineEvent {
  return {
    id,
    radioId: 1,
    ts,
    kind: "advert",
    advert: { contactKey: "a".repeat(64), name: "Node", type: "chat", flags: 0, outPathLen: -1, lat: null, lon: null, observed: "new" },
  };
}

describe("wsToTimelineEvent", () => {
  it("passes timeline.event payloads through untouched", () => {
    const event = advertEvent(NOW);
    expect(wsToTimelineEvent({ type: "timeline.event", radioId: 1, event })).toBe(event);
  });

  it("synthesizes a message entry from message.new", () => {
    const mapped = wsToTimelineEvent({ type: "message.new", radioId: 3, message: message() });
    expect(mapped).toMatchObject({ id: "msg:7", radioId: 3, ts: NOW, kind: "message" });
    if (mapped?.kind !== "message") throw new Error("expected message");
    expect(mapped.message.preview).toBe("hello out there");
  });

  it("truncates long message previews to 140 characters", () => {
    const mapped = wsToTimelineEvent({ type: "message.new", radioId: 1, message: message({ text: "x".repeat(500) }) });
    if (mapped?.kind !== "message") throw new Error("expected message");
    expect(mapped.message.preview).toHaveLength(140);
  });

  it("synthesizes alert and battery entries with matching id prefixes", () => {
    const alert = wsToTimelineEvent({
      type: "telemetry.alert",
      radioId: 2,
      event: {
        id: 11,
        ruleId: 1,
        contactKey: null,
        contactName: null,
        metric: "battery_mv",
        label: "Battery",
        value: 3000,
        threshold: 3500,
        comparator: "below",
        direction: "breach",
        ts: NOW,
      },
    });
    expect(alert).toMatchObject({ id: "alr:11", kind: "alert", ts: NOW });

    const sample = wsToTimelineEvent({ type: "telemetry", radioId: 2, batteryMilliVolts: 4100, ts: NOW });
    expect(sample).toMatchObject({ id: `tlm:live:2:${NOW}`, kind: "telemetry" });
    if (sample?.kind !== "telemetry") throw new Error("expected telemetry");
    expect(sample.telemetry.batteryMv).toBe(4100);
  });

  it("returns null for events that carry no timeline entry", () => {
    expect(wsToTimelineEvent({ type: "message.status", radioId: 1, id: 1, status: "sent" } as WsEvent)).toBeNull();
    expect(wsToTimelineEvent({ type: "status.changed" } as WsEvent)).toBeNull();
  });
});

describe("zoomAround", () => {
  const view = { start: NOW - 3600, end: NOW };

  it("keeps the anchor at the same fractional position", () => {
    const anchor = NOW - 900; // 75% across
    const zoomed = zoomAround(view, anchor, 0.5, NOW + 3600);
    const fraction = (anchor - zoomed.start) / (zoomed.end - zoomed.start);
    expect(fraction).toBeCloseTo(0.75, 5);
    expect(zoomed.end - zoomed.start).toBeCloseTo(1800, 5);
  });

  it("clamps to the minimum and maximum span", () => {
    const tiny = zoomAround(view, NOW - 1800, 0.000001, NOW);
    expect(tiny.end - tiny.start).toBe(MIN_SPAN);
    const huge = zoomAround(view, NOW - 1800, 1e9, NOW);
    expect(huge.end - huge.start).toBe(MAX_SPAN);
  });

  it("does not let the window drift far past now", () => {
    const zoomed = zoomAround({ start: NOW - 600, end: NOW }, NOW, 4, NOW);
    expect(zoomed.end).toBeLessThanOrEqual(NOW + (zoomed.end - zoomed.start) * 0.05 + 1);
  });
});

describe("panBy", () => {
  it("shifts the window while preserving the span", () => {
    const panned = panBy({ start: NOW - 3600, end: NOW - 1800 }, -600, NOW);
    expect(panned).toEqual({ start: NOW - 4200, end: NOW - 2400 });
  });

  it("stops panning at the future edge", () => {
    const panned = panBy({ start: NOW - 3600, end: NOW }, 7200, NOW);
    expect(panned.end).toBeLessThanOrEqual(NOW + 3600 * 0.05 + 1);
    expect(panned.end - panned.start).toBe(3600);
  });
});

describe("centerOn", () => {
  it("puts the target at the middle of the window, span unchanged", () => {
    const centered = centerOn({ start: NOW - 3600, end: NOW }, NOW - 86_400, NOW);
    expect(centered.end - centered.start).toBe(3600);
    expect((centered.start + centered.end) / 2).toBe(NOW - 86_400);
  });

  it("stops at the future edge instead of centring past it", () => {
    const centered = centerOn({ start: NOW - 3600, end: NOW }, NOW + 86_400, NOW);
    expect(centered.end).toBeLessThanOrEqual(NOW + 3600 * 0.05 + 1);
    expect(centered.end - centered.start).toBe(3600);
  });
});

describe("overviewDomain", () => {
  const view = { start: NOW - 3600, end: NOW };

  it("uses the stored extent when it contains the window", () => {
    const extent = { from: NOW - 86_400, to: NOW - 60 };
    expect(overviewDomain(extent, view)).toEqual({ start: NOW - 86_400, end: NOW });
  });

  it("widens to keep the window inside the strip", () => {
    const extent = { from: NOW - 600, to: NOW - 300 };
    expect(overviewDomain(extent, { start: NOW - 7200, end: NOW + 60 })).toEqual({ start: NOW - 7200, end: NOW + 60 });
  });

  it("falls back to the window when nothing is stored", () => {
    expect(overviewDomain(null, view)).toEqual(view);
  });

  it("never returns a zero-width domain", () => {
    const domain = overviewDomain({ from: NOW, to: NOW }, { start: NOW, end: NOW });
    expect(domain.end - domain.start).toBe(MIN_SPAN);
  });
});

describe("laneMetrics", () => {
  it("keeps the original geometry when the card is exactly one lane tall", () => {
    const metrics = laneMetrics(MIN_LANE_H + AXIS_H, 1);
    expect(metrics).toEqual({ laneH: 84, kindRowH: 12, padTop: 18, height: 114 });
  });

  it("never shrinks a lane below the floor, however little room there is", () => {
    const metrics = laneMetrics(40, 3);
    expect(metrics.laneH).toBe(MIN_LANE_H);
    expect(metrics.height).toBe(MIN_LANE_H * 3 + AXIS_H);
  });

  it("stretches lanes to fill a tall card and centres the kind rows", () => {
    const metrics = laneMetrics(630, 2);
    expect(metrics.laneH).toBe(300);
    expect(metrics.height).toBe(630);
    // rows stop spreading once they hit the cap; the slack becomes margin
    expect(metrics.kindRowH).toBe(44);
    expect(metrics.padTop).toBe((300 - 44 * 4) / 2);
  });

  it("treats an empty lane list as one lane", () => {
    expect(laneMetrics(200, 0).height).toBe(laneMetrics(200, 1).height);
  });
});

describe("timeTicks", () => {
  it("picks a step that keeps ticks at least ~80px apart", () => {
    const ticks = timeTicks(NOW - 3600, NOW, 800);
    // an hour across 800px: 10 ticks max → 5-minute steps won't fit, expect 900s
    expect(ticks.length).toBeGreaterThan(2);
    expect(ticks.length).toBeLessThanOrEqual(11);
    const deltas = ticks.slice(1).map((t, i) => t.ts - ticks[i].ts);
    expect(new Set(deltas).size).toBe(1);
  });

  it("uses date labels for multi-day spans", () => {
    const ticks = timeTicks(NOW - 14 * 86_400, NOW, 900);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.every((t) => t.major)).toBe(true);
    expect(ticks[0].label).toMatch(/^\d{1,2}\/\d{1,2}$/);
  });

  it("returns nothing for a degenerate window", () => {
    expect(timeTicks(NOW, NOW, 800)).toEqual([]);
    expect(timeTicks(NOW - 3600, NOW, 0)).toEqual([]);
  });
});

describe("clusterEvents", () => {
  const view = { start: NOW - 1000, end: NOW };

  it("groups events closer than the pixel threshold", () => {
    // 1000s over 1000px with 10px min gap → events within 10s cluster together
    const events = [advertEvent(NOW - 500, "adv:1"), advertEvent(NOW - 495, "adv:2"), advertEvent(NOW - 100, "adv:3")];
    const clusters = clusterEvents(events, view, 1000, 10);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].events).toHaveLength(2);
    expect(clusters[1].events).toHaveLength(1);
  });

  it("keeps well-spaced events separate", () => {
    const events = [advertEvent(NOW - 900, "adv:1"), advertEvent(NOW - 500, "adv:2"), advertEvent(NOW - 100, "adv:3")];
    expect(clusterEvents(events, view, 1000, 10)).toHaveLength(3);
  });

  it("chains dense runs into one cluster", () => {
    const events = Array.from({ length: 20 }, (_, i) => advertEvent(NOW - 500 + i * 2, `adv:${i}`));
    const clusters = clusterEvents(events, view, 1000, 10);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].events).toHaveLength(20);
  });
});
