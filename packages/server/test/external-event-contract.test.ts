import { describe, expect, it } from "vitest";
import {
  externalContactRemovedEventSchema,
  externalContactUpdatedEventSchema,
  externalMessageCreatedEventSchema,
  externalMessageStatusChangedEventSchema,
  externalRadioLinkChangedEventSchema,
  externalRadioStatusChangedEventSchema,
  externalTelemetryAlertTriggeredEventSchema,
  externalTelemetryReceivedEventSchema,
  externalEventEnvelopeSchema,
  projectWsEvent,
  type ExternalEventEnvelope,
  type WsEvent,
} from "@meshkeep/shared";

const NOW = "2026-07-27T10:20:30.123Z";
const EVENT_ID = "01JABCDEF0123456789ABCDEF0";
const CONTACT_KEY = "a".repeat(64);

function project(
  event: WsEvent,
  options: Parameters<typeof projectWsEvent>[1] = {},
): ExternalEventEnvelope | null {
  return projectWsEvent(event, { id: EVENT_ID, occurredAt: NOW, ...options });
}

function message(overrides: Record<string, unknown> = {}): WsEvent {
  return {
    type: "message.new",
    radioId: 7,
    message: {
      id: 1842,
      kind: "dm",
      contactKey: CONTACT_KEY,
      contactPrefix: null,
      contactName: "Alice",
      channelIdx: null,
      channelName: null,
      direction: "in",
      text: "private body",
      senderTimestamp: 1_785_166_830,
      pathLen: 2,
      status: "sent",
      createdAt: 1_785_166_831,
      ingestionId: "client-only-id",
      ...overrides,
    },
  } as WsEvent;
}

describe("external event contract", () => {
  it("exposes a named schema for each stable external event shape", () => {
    const event = project(message());

    expect(externalMessageCreatedEventSchema.parse(event)).toMatchObject({
      id: EVENT_ID,
      type: "message.created",
      eventVersion: 1,
      occurredAt: NOW,
      source: { product: "meshkeep", apiVersion: "v1", radioId: 7 },
      data: {
        message: {
          id: 1842,
          kind: "dm",
          direction: "in",
          contactKey: CONTACT_KEY,
          contactName: "Alice",
          channelIdx: null,
          channelName: null,
          senderTimestamp: 1_785_166_830,
          status: "sent",
          createdAt: 1_785_166_831,
        },
      },
    });
  });

  it("projects every supported bus event into a valid explicit v1 fixture", () => {
    const fixtures: WsEvent[] = [
      message(),
      { type: "message.status", radioId: 7, id: 1842, status: "delivered" },
      {
        type: "contact.updated",
        radioId: 7,
        contact: {
          publicKey: CONTACT_KEY,
          name: "Alice",
          type: "chat",
          flags: 3,
          outPathLen: 2,
          lat: 45.5,
          lon: -122.6,
          lastAdvert: 100,
          lastSeen: 101,
        },
      },
      { type: "contact.removed", radioId: 7, publicKey: CONTACT_KEY },
      { type: "telemetry", radioId: 7, batteryMilliVolts: 3900, ts: 102 },
      {
        type: "telemetry.alert",
        radioId: 7,
        event: {
          id: 3,
          ruleId: 4,
          contactKey: CONTACT_KEY,
          contactName: "Alice",
          metric: "battery_mv",
          label: "Battery",
          value: 3200,
          threshold: 3500,
          comparator: "below",
          direction: "breach",
          ts: 103,
        },
      },
      {
        type: "timeline.event",
        radioId: 7,
        event: {
          id: "lnk:5",
          radioId: 7,
          ts: 104,
          kind: "link",
          link: {
            state: "disconnected",
            transport: "tcp",
            label: "Workshop",
            error: "socket timeout to 192.168.1.9",
          },
        },
      },
      {
        type: "status.changed",
        status: {
          connection: {
            state: "connected",
            transport: "tcp",
            target: "10.0.0.4:5000",
            lastError: "raw internal detail",
            connectedAt: 105,
          },
          self: null,
          batteryMilliVolts: 3900,
          counts: { contacts: 2, messages: 4, unread: 1 },
          activeRadioId: 7,
          radios: [],
          links: [],
          version: "0.1.4",
        },
      },
    ];

    const schemas = [
      externalMessageCreatedEventSchema,
      externalMessageStatusChangedEventSchema,
      externalContactUpdatedEventSchema,
      externalContactRemovedEventSchema,
      externalTelemetryReceivedEventSchema,
      externalTelemetryAlertTriggeredEventSchema,
      externalRadioLinkChangedEventSchema,
      externalRadioStatusChangedEventSchema,
    ];
    const envelopes = fixtures.map((event) => project(event));

    expect(envelopes).not.toContain(null);
    for (const [index, envelope] of envelopes.entries()) {
      expect(externalEventEnvelopeSchema.safeParse(envelope).success).toBe(true);
      expect(schemas[index]?.safeParse(envelope).success).toBe(true);
    }
  });

  it("omits sensitive data by default and includes only documented fields when opted in", () => {
    const defaultEnvelope = project(message());
    const sensitiveEnvelope = project(message(), { includeSensitive: true });
    const contactDefault = project({
      type: "contact.updated",
      radioId: 7,
      contact: {
        publicKey: CONTACT_KEY,
        name: "Alice",
        type: "chat",
        flags: 0,
        outPathLen: 1,
        lat: 45.5,
        lon: -122.6,
        lastAdvert: 100,
        lastSeen: null,
      },
    });
    const contactSensitive = project(
      {
        type: "contact.updated",
        radioId: 7,
        contact: {
          publicKey: CONTACT_KEY,
          name: "Alice",
          type: "chat",
          flags: 0,
          outPathLen: 1,
          lat: 45.5,
          lon: -122.6,
          lastAdvert: 100,
          lastSeen: null,
        },
      },
      { includeSensitive: true },
    );

    expect(defaultEnvelope).toMatchObject({ data: { message: { id: 1842 } } });
    expect(JSON.stringify(defaultEnvelope)).not.toContain("private body");
    expect(sensitiveEnvelope).toMatchObject({ data: { message: { text: "private body" } } });
    expect(JSON.stringify(contactDefault)).not.toMatch(/"lat"|"lon"/);
    expect(contactSensitive).toMatchObject({ data: { contact: { lat: 45.5, lon: -122.6 } } });
  });

  it("uses allow-list event types and radio ids without wildcard behavior", () => {
    const event = message();
    const radioEvent: WsEvent = {
      type: "timeline.event",
      radioId: 7,
      event: {
        id: "lnk:7",
        radioId: 7,
        ts: 104,
        kind: "link",
        link: { state: "connected", transport: "ble", label: "Field", error: null },
      },
    };

    expect(project(event, { eventTypes: ["contact.updated"] })).toBeNull();
    expect(project(event, { radioIds: [8] })).toBeNull();
    expect(project(event, { eventTypes: ["message.created"], radioIds: [7] })?.type).toBe("message.created");
    expect(project(radioEvent, { radioIds: [8] })).toBeNull();
    expect(project(radioEvent, { eventTypes: ["radio.link_changed"], radioIds: [7] })?.type).toBe(
      "radio.link_changed",
    );
  });

  it("never leaks internal secrets, targets, raw diagnostics, or unsupported bus events", () => {
    const envelope = project(
      message({
        channelName: "Ops",
        secret: "channel-secret",
        rawFrame: "beef",
        diagnostics: { databasePath: "/private/db" },
      }),
    );
    const alert = project({
      type: "telemetry.alert",
      radioId: 7,
      event: {
        id: 3,
        ruleId: 4,
        contactKey: CONTACT_KEY,
        contactName: "Alice",
        metric: "battery_mv",
        label: "Battery",
        value: 3200,
        threshold: 3500,
        comparator: "below",
        direction: "breach",
        ts: 103,
        secret: "alert-secret",
        rawFrame: "beef",
      },
    } as WsEvent);
    const link = project({
      type: "timeline.event",
      radioId: 7,
      event: {
        id: "lnk:5",
        radioId: 7,
        ts: 104,
        kind: "link",
        link: {
          state: "disconnected",
          transport: "tcp",
          label: "Workshop",
          error: "socket timeout to 192.168.1.9",
        },
      },
    });

    expect(JSON.stringify(envelope)).not.toMatch(
      /channel-secret|rawFrame|databasePath|client-only-id|pathLen/,
    );
    expect(JSON.stringify(alert)).not.toMatch(/alert-secret|rawFrame/);
    expect(link).toMatchObject({ data: { radio: { errorCode: "timeout" } } });
    expect(JSON.stringify(link)).not.toContain("192.168.1.9");
    expect(project({ type: "self.updated", radioId: 7, self: {} } as WsEvent)).toBeNull();
  });

  it("accepts additive unknown optional fields while rejecting incompatible envelope versions", () => {
    const envelope = project(message());
    expect(externalEventEnvelopeSchema.safeParse({ ...envelope, futureOptional: "ignore me" }).success).toBe(
      true,
    );
    expect(
      externalEventEnvelopeSchema.safeParse({
        ...envelope,
        source: { ...envelope?.source, apiVersion: "v2" },
      }).success,
    ).toBe(false);
  });
});
