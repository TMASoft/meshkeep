import { describe, expect, it } from "vitest";
import request from "supertest";
import { openDb } from "../src/db/index.js";
import { DuplicateProfileNameError, Store } from "../src/db/store.js";
import { buildHarness } from "./helpers.js";

describe("radio profile store", () => {
  it("creates profiles with connection defaults and lists them by name", () => {
    const store = new Store(openDb(":memory:"));
    const bench = store.createRadioProfile({ name: "Bench", connection: "serial", serialPort: "/dev/ttyMESH" });
    store.createRadioProfile({ name: "Attic", connection: "tcp", tcpHost: "10.0.0.5" });

    expect(bench.serialBaud).toBe(115_200); // defaults fill unspecified fields
    expect(bench.tcpPort).toBe(5_000);
    expect(bench.bleAddress).toBeNull();
    expect(store.listRadioProfiles().map((p) => p.name)).toEqual(["Attic", "Bench"]);
    expect(store.getRadioProfile(bench.id)?.serialPort).toBe("/dev/ttyMESH");
    expect(store.getRadioProfile(9999)).toBeNull();
  });

  it("rejects duplicate names on create and rename", () => {
    const store = new Store(openDb(":memory:"));
    store.createRadioProfile({ name: "Bench", connection: "none" });
    const other = store.createRadioProfile({ name: "Attic", connection: "none" });

    expect(() => store.createRadioProfile({ name: "Bench", connection: "none" })).toThrow(DuplicateProfileNameError);
    expect(() => store.updateRadioProfile(other.id, { name: "Bench" })).toThrow(DuplicateProfileNameError);
  });

  it("applies partial updates and deletes", () => {
    const store = new Store(openDb(":memory:"));
    const profile = store.createRadioProfile({ name: "Bench", connection: "serial", serialPort: "/dev/ttyMESH" });

    const updated = store.updateRadioProfile(profile.id, { connection: "tcp", tcpHost: "10.0.0.7", tcpPort: 4403 });
    expect(updated).toMatchObject({ name: "Bench", connection: "tcp", tcpHost: "10.0.0.7", tcpPort: 4403 });
    // untouched fields survive a partial update
    expect(updated?.serialPort).toBe("/dev/ttyMESH");

    expect(store.updateRadioProfile(9999, { name: "Ghost" })).toBeNull();
    expect(store.deleteRadioProfile(profile.id)).toBe(true);
    expect(store.deleteRadioProfile(profile.id)).toBe(false);
    expect(store.listRadioProfiles()).toHaveLength(0);
  });
});

describe("http: radio profiles", () => {
  it("runs the create → activate → guard → deactivate → delete lifecycle", async () => {
    const { app } = buildHarness();

    const created = await request(app)
      .post("/api/v1/radio/profiles")
      .send({ name: "Bench", connection: "none" })
      .expect(201);
    expect(created.body).toMatchObject({ name: "Bench", connection: "none" });

    const list = await request(app).get("/api/v1/radio/profiles").expect(200);
    expect(list.body.profiles).toHaveLength(1);
    expect(list.body.activeProfileId).toBeNull();

    const activated = await request(app).post(`/api/v1/radio/profiles/${created.body.id}/activate`).expect(200);
    expect(activated.body.activeProfile.id).toBe(created.body.id);
    expect(activated.body.effective.connection).toBe("none");
    expect(activated.body.state).toBe("disconnected");
    const listActive = await request(app).get("/api/v1/radio/profiles").expect(200);
    expect(listActive.body.activeProfileId).toBe(created.body.id);

    // the active profile cannot be deleted
    await request(app).delete(`/api/v1/radio/profiles/${created.body.id}`).expect(409);

    const deactivated = await request(app).post("/api/v1/radio/profiles/deactivate").expect(200);
    expect(deactivated.body.activeProfile).toBeNull();

    await request(app).delete(`/api/v1/radio/profiles/${created.body.id}`).expect(200);
    expect((await request(app).get("/api/v1/radio/profiles").expect(200)).body.profiles).toHaveLength(0);
  });

  it("updates profiles and surfaces conflicts and unknown ids", async () => {
    const { app } = buildHarness();

    const bench = await request(app)
      .post("/api/v1/radio/profiles")
      .send({ name: "Bench", connection: "none" })
      .expect(201);
    await request(app).post("/api/v1/radio/profiles").send({ name: "Attic", connection: "none" }).expect(201);

    // duplicate names conflict on create and rename
    await request(app).post("/api/v1/radio/profiles").send({ name: "Bench", connection: "none" }).expect(409);
    await request(app).put(`/api/v1/radio/profiles/${bench.body.id}`).send({ name: "Attic" }).expect(409);

    const updated = await request(app)
      .put(`/api/v1/radio/profiles/${bench.body.id}`)
      .send({ connection: "tcp", tcpHost: "10.0.0.7", tcpPort: 4403 })
      .expect(200);
    expect(updated.body).toMatchObject({ name: "Bench", connection: "tcp", tcpHost: "10.0.0.7", tcpPort: 4403 });

    await request(app).put("/api/v1/radio/profiles/9999").send({ name: "Ghost" }).expect(404);
    await request(app).delete("/api/v1/radio/profiles/9999").expect(404);
    await request(app).post("/api/v1/radio/profiles/9999/activate").expect(404);
  });

  it("validates profile payloads", async () => {
    const { app } = buildHarness();
    // missing name
    await request(app).post("/api/v1/radio/profiles").send({ connection: "none" }).expect(400);
    // blank name
    await request(app).post("/api/v1/radio/profiles").send({ name: "   ", connection: "none" }).expect(400);
    // bad transport
    await request(app).post("/api/v1/radio/profiles").send({ name: "X", connection: "smoke" }).expect(400);
    // malformed BLE address
    await request(app)
      .post("/api/v1/radio/profiles")
      .send({ name: "X", connection: "ble", bleAddress: "not-a-mac" })
      .expect(400);
    // out-of-range tcp port
    await request(app)
      .post("/api/v1/radio/profiles")
      .send({ name: "X", connection: "tcp", tcpHost: "10.0.0.1", tcpPort: 70000 })
      .expect(400);
    // non-numeric id
    await request(app).put("/api/v1/radio/profiles/abc").send({ name: "X" }).expect(400);
  });

  it("clears the profile selection when an explicit override is saved", async () => {
    const { app } = buildHarness();
    const created = await request(app)
      .post("/api/v1/radio/profiles")
      .send({ name: "Bench", connection: "none" })
      .expect(201);
    await request(app).post(`/api/v1/radio/profiles/${created.body.id}/activate`).expect(200);

    const overridden = await request(app)
      .put("/api/v1/connection/config")
      .send({ override: { connection: "none" } })
      .expect(200);
    expect(overridden.body.activeProfile).toBeNull();
    expect((await request(app).get("/api/v1/radio/profiles").expect(200)).body.activeProfileId).toBeNull();
  });
});
