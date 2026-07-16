import { existsSync } from "node:fs";
import { SerialPort } from "serialport";
import { Constants } from "@liamcottle/meshcore.js";
import { createBluetooth } from "node-ble";
import type { DetectedSerialPort, BleCandidate } from "@meshkeep/shared";

// Exact VID:PID matches for boards we can name outright.
const KNOWN_BOARDS: Record<string, string> = {
  "239a:8029": "RAK4631 (RAKwireless)",
};

// USB-serial vendors that companion radios commonly enumerate as. A match
// means "plausibly a radio", not a guarantee — unrecognized ports are still
// listed so unusual boards keep working.
const KNOWN_VENDORS: Record<string, string> = {
  "239a": "Adafruit nRF52 bootloader (RAK4631 and similar)",
  "2886": "Seeed (XIAO nRF52840)",
  "303a": "Espressif native USB (ESP32-S2/S3 boards)",
  "10c4": "Silicon Labs CP210x bridge (Heltec and similar)",
  "1a86": "QinHeng CH340/CH910x bridge (LilyGo and similar)",
  "0403": "FTDI bridge",
};

interface RawPortInfo {
  path: string;
  manufacturer?: string;
  pnpId?: string;
  vendorId?: string;
  productId?: string;
}

/** Pure classifier so ranking is unit-testable without hardware. */
export function classifySerialPort(info: RawPortInfo): DetectedSerialPort {
  const vendorId = info.vendorId?.toLowerCase() ?? null;
  const productId = info.productId?.toLowerCase() ?? null;
  const board = vendorId && productId ? KNOWN_BOARDS[`${vendorId}:${productId}`] : undefined;
  const vendor = vendorId ? KNOWN_VENDORS[vendorId] : undefined;
  // /dev/serial/by-id/<pnpId> is the stable symlink udev creates for the same
  // device; prefer it so the config survives re-enumeration.
  const byIdPath = info.pnpId ? `/dev/serial/by-id/${info.pnpId}` : null;
  return {
    path: byIdPath && existsSync(byIdPath) ? byIdPath : info.path,
    rawPath: info.path,
    manufacturer: info.manufacturer ?? null,
    vendorId,
    productId,
    label: board ?? vendor ?? info.manufacturer ?? "Unrecognized USB serial device",
    likelyRadio: Boolean(board ?? vendor),
  };
}

/**
 * Enumerate candidate USB serial devices. Legacy motherboard UARTs (no USB
 * vendor id or pnp id) are dropped; everything USB is returned, likely
 * radios first. Inside Docker only devices mapped with `devices:` (or a
 * mounted /dev/serial/by-id) are visible.
 */
export async function listSerialPorts(): Promise<DetectedSerialPort[]> {
  let ports: RawPortInfo[];
  try {
    ports = await SerialPort.list();
  } catch (error) {
    // enumeration backend unavailable (e.g. no udevadm in a minimal
    // container) — the UI falls back to manual entry
    console.warn("[detect] serial enumeration failed:", error instanceof Error ? error.message : error);
    return [];
  }
  return ports
    .filter((port) => port.vendorId || port.pnpId)
    .map((port) => classifySerialPort(port))
    .sort((a, b) => Number(b.likelyRadio) - Number(a.likelyRadio) || a.path.localeCompare(b.path));
}

const NUS_SERVICE_UUID = Constants.Ble.ServiceUuid.toLowerCase();

/**
 * Short BlueZ discovery window (Linux/D-Bus hosts only) listing nearby BLE
 * devices. Companion radios advertise the Nordic UART service; those are
 * flagged and sorted first, but named devices are kept so a radio whose
 * advertisement doesn't carry service UUIDs still shows up.
 */
export async function scanBleRadios(durationMs: number): Promise<BleCandidate[]> {
  const { bluetooth, destroy } = createBluetooth();
  let startedDiscovery = false;
  try {
    const adapter = await bluetooth.defaultAdapter();
    if (!(await adapter.isDiscovering())) {
      try {
        await adapter.startDiscovery();
        startedDiscovery = true;
      } catch {
        // another BlueZ client is already discovering — its scan feeds us too
      }
    }
    await new Promise((resolve) => setTimeout(resolve, durationMs));

    const candidates: BleCandidate[] = [];
    for (const address of await adapter.devices()) {
      try {
        const device = await adapter.getDevice(address);
        const helper = (device as unknown as { helper: { prop(name: string): Promise<unknown> } }).helper;
        const name = await device.getName().catch(() => null);
        const uuids = (await helper.prop("UUIDs").catch(() => [])) as string[];
        const nus = uuids.some((uuid) => uuid.toLowerCase() === NUS_SERVICE_UUID);
        if (!nus && !name) continue; // anonymous non-radio advertisements are noise
        candidates.push({
          address,
          name,
          rssi: (await device.getRSSI().catch(() => null)) as number | null,
          paired: Boolean(await device.isPaired().catch(() => false)),
          nus,
        });
      } catch {
        // device vanished mid-scan
      }
    }
    if (startedDiscovery) await adapter.stopDiscovery().catch(() => {});
    return candidates.sort((a, b) => Number(b.nus) - Number(a.nus) || (b.rssi ?? -999) - (a.rssi ?? -999));
  } finally {
    destroy();
  }
}
