import { Connection, Constants } from "@liamcottle/meshcore.js";
import { createBluetooth } from "node-ble";
import type { Adapter, Device, GattCharacteristic } from "node-ble";
import { leaseDiscovery, type DiscoveryLease } from "./ble-discovery.js";

const DISCOVER_TIMEOUT_MS = 30_000;

/**
 * Server-side BLE transport over BlueZ/D-Bus (Linux only; in Docker the host
 * D-Bus socket must be mounted — see docker/compose.ble.yml).
 *
 * The companion BLE firmware exposes the Nordic UART service: protocol frames
 * are written to the RX characteristic and received as TX notifications, one
 * frame per write/notification — no `>` + length framing like serial/TCP.
 *
 * Pairing is expected to be done once on the host with bluetoothctl (BLE
 * companion firmware defaults to PIN 123456); node-ble cannot answer BlueZ
 * pairing agent prompts itself.
 */
export class BleNodeConnection extends Connection {
  private destroyBluetooth: (() => void) | null = null;
  private adapter: Adapter | null = null;
  private device: Device | null = null;
  private rx: GattCharacteristic | null = null;
  private tx: GattCharacteristic | null = null;
  private releaseDiscovery: DiscoveryLease | null = null;

  constructor(private readonly address: string) {
    super();
  }

  async connect(): Promise<void> {
    const { bluetooth, destroy } = createBluetooth();
    this.destroyBluetooth = destroy;
    try {
      this.adapter = await bluetooth.defaultAdapter();
      // Own discovery through the lease; close() releases it on every failure
      // path (wait timeout, pairing, connect, GATT), never leaving it running.
      this.releaseDiscovery = await leaseDiscovery(this.adapter);

      this.device = await this.adapter.waitDevice(this.address.toUpperCase(), DISCOVER_TIMEOUT_MS);

      // Bonded devices reconnect silently; unbonded ones need a one-time
      // bluetoothctl pairing on the host (PIN prompts can't be answered here).
      try {
        const paired = await this.device.isPaired();
        if (String(paired) !== "true") {
          await this.device.pair();
        }
      } catch (error) {
        console.warn(
          `[ble] pairing with ${this.address} failed (pair once on the host with bluetoothctl, PIN 123456):`,
          error instanceof Error ? error.message : error,
        );
      }

      await this.device.connect();
      const gatt = await this.device.gatt();
      const service = await gatt.getPrimaryService(Constants.Ble.ServiceUuid.toLowerCase());
      this.rx = await service.getCharacteristic(Constants.Ble.CharacteristicUuidRx.toLowerCase());
      this.tx = await service.getCharacteristic(Constants.Ble.CharacteristicUuidTx.toLowerCase());

      this.tx.on("valuechanged", (buffer: Buffer) => {
        // one complete protocol frame per notification
        this.onFrameReceived(Array.from(buffer));
      });
      await this.tx.startNotifications();

      this.device.on("disconnect", () => {
        this.onDisconnected();
      });

      // connected — discovery is no longer needed
      await this.releaseDiscovery();
      this.releaseDiscovery = null;

      await this.onConnected();
    } catch (error) {
      await this.close();
      throw error instanceof Error ? error : new Error(`BLE connect to ${this.address} failed`);
    }
  }

  async close(): Promise<void> {
    if (this.tx) {
      await this.tx.stopNotifications().catch(() => {});
      this.tx = null;
    }
    this.rx = null;
    if (this.device) {
      await this.device.disconnect().catch(() => {});
      this.device = null;
    }
    if (this.releaseDiscovery) {
      await this.releaseDiscovery();
      this.releaseDiscovery = null;
    }
    this.adapter = null;
    if (this.destroyBluetooth) {
      this.destroyBluetooth();
      this.destroyBluetooth = null;
    }
  }

  async sendToRadioFrame(data: Uint8Array | number[]): Promise<void> {
    if (!this.rx) throw new Error("BLE connection is not open");
    this.emit("tx", data);
    await this.rx.writeValueWithResponse(Buffer.from(data as Uint8Array));
  }
}
