/**
 * Canary for @liamcottle/meshcore.js (issue #21): the ambient declarations in
 * packages/server/src/types/meshcore.d.ts and
 * packages/web/src/types/meshcore-web.d.ts are hand-maintained, so a
 * dependabot bump that renames or removes a surface we declare must fail here
 * loudly instead of silently drifting from the .d.ts files.
 */
import { describe, expect, it } from "vitest";
import {
  BufferUtils,
  CayenneLpp,
  Connection,
  Constants,
  NodeJSSerialConnection,
  TCPConnection,
  WebBleConnection,
  WebSerialConnection,
} from "@liamcottle/meshcore.js";

const CONNECTION_METHODS = [
  "on",
  "off",
  "once",
  "emit",
  "close",
  "onFrameReceived",
  "onConnected",
  "onDisconnected",
  "getSelfInfo",
  "deviceQuery",
  "getContacts",
  "getBatteryVoltage",
  "getDeviceTime",
  "setDeviceTime",
  "syncDeviceTime",
  "syncNextMessage",
  "sendTextMessage",
  "sendChannelTextMessage",
  "sendFloodAdvert",
  "sendZeroHopAdvert",
  "setAdvertName",
  "setAdvertLatLong",
  "setTxPower",
  "setRadioParams",
  "removeContact",
  "resetPath",
  "login",
  "getStatus",
  "getTelemetry",
  "importContact",
  "exportContact",
  "shareContact",
  "sendCommandGetChannel",
  "sendCommandSetChannel",
  "sendCommandAppStart",
  "onContactMsgRecvResponse",
] as const;

describe("meshcore.js surface canary", () => {
  it("exports every class/namespace our .d.ts declares", () => {
    expect(typeof Connection).toBe("function");
    expect(typeof NodeJSSerialConnection).toBe("function");
    expect(typeof TCPConnection).toBe("function");
    expect(typeof WebSerialConnection).toBe("function");
    expect(typeof WebBleConnection).toBe("function");
    expect(typeof CayenneLpp.parse).toBe("function");
  });

  it("Connection has every method we declare and call", () => {
    for (const method of CONNECTION_METHODS) {
      expect(typeof (Connection.prototype as Record<string, unknown>)[method], method).toBe("function");
    }
    // connect() lives on the concrete transports, not the base class
    expect(typeof NodeJSSerialConnection.prototype.connect).toBe("function");
    expect(typeof TCPConnection.prototype.connect).toBe("function");
  });

  it("keeps the constants we depend on", () => {
    expect(typeof Constants.SupportedCompanionProtocolVersion).toBe("number");
    expect(Constants.Ble.ServiceUuid).toMatch(/^6E400001/i);
    expect(Constants.Ble.CharacteristicUuidRx).toMatch(/^6E400002/i);
    expect(Constants.Ble.CharacteristicUuidTx).toMatch(/^6E400003/i);
    // patchSignedPlain in transports.ts re-parses this response code's frames
    expect(typeof Constants.ResponseCodes.ContactMsgRecv).toBe("number");
    expect(typeof Constants.TxtTypes.SignedPlain).toBe("number");
    expect(typeof Constants.TxtTypes.Plain).toBe("number");
    expect(typeof Constants.TxtTypes.CliData).toBe("number");
    expect(Constants.AdvType).toMatchObject({ None: 0, Chat: 1, Repeater: 2, Room: 3 });
    expect(typeof Constants.SelfAdvertTypes.ZeroHop).toBe("number");
    expect(typeof Constants.SelfAdvertTypes.Flood).toBe("number");
  });

  it("BufferUtils round-trips hex", () => {
    const bytes = BufferUtils.hexToBytes("8b3387e9");
    expect([...bytes]).toEqual([0x8b, 0x33, 0x87, 0xe9]);
    expect(BufferUtils.bytesToHex(bytes)).toBe("8b3387e9");
    expect(BufferUtils.areBuffersEqual(bytes, BufferUtils.hexToBytes("8b3387e9"))).toBe(true);
  });

  it("CayenneLpp parses a temperature reading the way the server expects", () => {
    // channel 1, type 0x67 (temperature, 0.1 °C), value 0x00FF = 25.5
    const readings = CayenneLpp.parse(Uint8Array.from([0x01, 0x67, 0x00, 0xff]));
    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({ channel: 1, type: 0x67, value: 25.5 });
  });

  it("web subpath modules our web .d.ts declares still resolve", async () => {
    const [connection, webSerial, webBle, constants, bufferUtils] = await Promise.all([
      import("@liamcottle/meshcore.js/src/connection/connection.js"),
      import("@liamcottle/meshcore.js/src/connection/web_serial_connection.js"),
      import("@liamcottle/meshcore.js/src/connection/web_ble_connection.js"),
      import("@liamcottle/meshcore.js/src/constants.js"),
      import("@liamcottle/meshcore.js/src/buffer_utils.js"),
    ]);
    expect(typeof connection.default).toBe("function");
    expect(typeof webSerial.default).toBe("function");
    expect(typeof webBle.default).toBe("function");
    expect(constants.default ?? constants).toBeTruthy();
    expect(bufferUtils.default ?? bufferUtils).toBeTruthy();
  });
});
