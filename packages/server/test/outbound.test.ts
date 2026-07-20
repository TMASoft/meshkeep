import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { Store } from "../src/db/store.js";

function storeWithDmMessage(text = "hi") {
  const db = openDb(":memory:");
  const store = new Store(db);
  const radioId = store.resolveRadio("f".repeat(64), "Test Radio");
  const message = store.insertMessage(radioId, {
    kind: "dm",
    contactKey: "a".repeat(64),
    direction: "out",
    text,
    senderTimestamp: 1_000,
    status: "pending",
  })!;
  return { db, store, message, radioId };
}

describe("outbound queue store", () => {
  it("enqueues, selects due entries, and removes on success", () => {
    const { store, message, radioId } = storeWithDmMessage();
    store.enqueueOutbound({
      radioId,
      messageId: message.id,
      kind: "dm",
      contactKey: "a".repeat(64),
      text: "hi",
      maxAttempts: 5,
      nextAttemptAt: 1_000,
    });

    expect(store.takeDueOutbound(radioId, 999)).toHaveLength(0); // not yet due
    const due = store.takeDueOutbound(radioId, 1_000);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ messageId: message.id, kind: "dm", state: "pending", attempts: 0, cli: false });

    store.removeOutbound(message.id);
    expect(store.getOutbound(message.id)).toBeNull();
    expect(store.nextOutboundAttemptAt(radioId)).toBeNull();
  });

  it("overlays `retrying` on the message while the queue entry is backing off", () => {
    const { store, message, radioId } = storeWithDmMessage();
    store.enqueueOutbound({
      radioId,
      messageId: message.id,
      kind: "dm",
      contactKey: "a".repeat(64),
      text: "hi",
      maxAttempts: 5,
      nextAttemptAt: 1_000,
    });
    // a queued-but-not-yet-attempted send still reads as pending
    expect(store.getMessage(message.id)?.status).toBe("pending");

    store.markOutboundAttempt(message.id, { state: "retrying", attempts: 1, nextAttemptAt: 2_000, lastError: "boom" });
    // the stored coarse status is untouched, but reads overlay `retrying`
    expect(store.getMessage(message.id)?.status).toBe("retrying");
    expect(store.getRecentMessages(radioId, 10)[0]?.status).toBe("retrying");
    // a failed entry no longer overlays; the message's own status shows through
    store.markOutboundAttempt(message.id, { state: "failed", attempts: 5, nextAttemptAt: 2_000, lastError: "boom" });
    store.setMessageStatus(message.id, "failed");
    expect(store.getMessage(message.id)?.status).toBe("failed");
  });

  it("excludes failed entries from due selection until reset for retry", () => {
    const { store, message, radioId } = storeWithDmMessage();
    store.enqueueOutbound({
      radioId,
      messageId: message.id,
      kind: "dm",
      contactKey: "a".repeat(64),
      text: "hi",
      maxAttempts: 5,
      nextAttemptAt: 1_000,
    });
    store.markOutboundAttempt(message.id, { state: "failed", attempts: 5, nextAttemptAt: 1_000, lastError: "dead" });

    expect(store.takeDueOutbound(radioId, 9_999)).toHaveLength(0);
    expect(store.nextOutboundAttemptAt(radioId)).toBeNull();
    expect(store.listOutbound(radioId)).toHaveLength(1); // still visible in the ledger

    store.resetOutboundForRetry(message.id, 3_000);
    const entry = store.getOutbound(message.id)!;
    expect(entry).toMatchObject({ state: "pending", attempts: 0, nextAttemptAt: 3_000, lastError: null });
    expect(store.takeDueOutbound(radioId, 3_000)).toHaveLength(1);
  });

  it("cascades queue rows when the message is deleted", () => {
    const { db, store, message, radioId } = storeWithDmMessage();
    store.enqueueOutbound({
      radioId,
      messageId: message.id,
      kind: "dm",
      contactKey: "a".repeat(64),
      text: "hi",
      maxAttempts: 5,
      nextAttemptAt: 1_000,
    });
    db.prepare("DELETE FROM messages WHERE id = ?").run(message.id);
    expect(store.getOutbound(message.id)).toBeNull();
  });
});
