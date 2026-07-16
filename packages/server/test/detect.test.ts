import { describe, expect, it } from "vitest";
import request from "supertest";
import { classifySerialPort } from "../src/radio/detect.js";
import { buildHarness } from "./helpers.js";

describe("classifySerialPort", () => {
  it("names a RAK4631 outright and prefers the stable by-id path shape", () => {
    const port = classifySerialPort({
      path: "/dev/ttyACM0",
      manufacturer: "RAKwireless",
      pnpId: "usb-RAKwireless_WisCore_RAK4631_Board_AEFC568A70AAD893-if00",
      vendorId: "239A",
      productId: "8029",
    });
    expect(port.label).toContain("RAK4631");
    expect(port.likelyRadio).toBe(true);
    expect(port.rawPath).toBe("/dev/ttyACM0");
    // by-id path only used when the symlink exists on this machine
    expect([port.rawPath, "/dev/serial/by-id/usb-RAKwireless_WisCore_RAK4631_Board_AEFC568A70AAD893-if00"]).toContain(
      port.path,
    );
  });

  it("flags known USB-serial bridge vendors as likely radios", () => {
    const port = classifySerialPort({ path: "/dev/ttyUSB0", vendorId: "10c4", productId: "ea60" });
    expect(port.likelyRadio).toBe(true);
    expect(port.label).toContain("CP210x");
  });

  it("keeps unrecognized USB devices, unflagged", () => {
    const port = classifySerialPort({ path: "/dev/ttyACM1", vendorId: "dead", productId: "beef", manufacturer: "Acme" });
    expect(port.likelyRadio).toBe(false);
    expect(port.label).toBe("Acme");
  });
});

describe("GET /api/v1/system/ports", () => {
  it("returns a port list", async () => {
    const { app } = buildHarness();
    const res = await request(app).get("/api/v1/system/ports");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.ports)).toBe(true);
    for (const port of res.body.ports) {
      expect(typeof port.path).toBe("string");
      expect(typeof port.likelyRadio).toBe("boolean");
    }
  });
});
