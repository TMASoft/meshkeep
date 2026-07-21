# Upstream report for liamcottle/meshcore.js

Filed as [meshcore-dev/meshcore.js#34](https://github.com/meshcore-dev/meshcore.js/issues/34),
tracked by MeshKeep issue #21. We carry a local workaround
(`patchSignedPlain` in `packages/server/src/radio/transports.ts` and the
equivalent in the web browser-direct path); once fixed upstream we can drop it
and pin the minimum version.

---

**Title:** `onContactMsgRecvResponse` mangles the 4 raw author-pubkey bytes on
SignedPlain (room server) messages

**Version:** 1.13.0

## Summary

For `TxtTypes.SignedPlain` (2) contact messages — how room servers deliver
posts — the companion frame carries **4 raw bytes of the original author's
public key** between `senderTimestamp` and the message text (see the firmware's
`CMD_SYNC_NEXT_MESSAGE` handling for signed posts). `onContactMsgRecvResponse`
decodes the entire remainder as UTF-8:

```js
onContactMsgRecvResponse(bufferReader) {
    this.emit(Constants.ResponseCodes.ContactMsgRecv, {
        pubKeyPrefix: bufferReader.readBytes(6),
        pathLen: bufferReader.readByte(),
        txtType: bufferReader.readByte(),
        senderTimestamp: bufferReader.readUInt32LE(),
        text: bufferReader.readString(),   // <-- 4 raw key bytes swallowed into UTF-8
    });
}
```

The 4 author bytes are usually not valid UTF-8, so they surface as U+FFFD
replacement characters (or mojibake) prefixed to `text`, and the author
attribution is unrecoverable by the consumer.

## Repro

```js
import { Connection, Constants } from "@liamcottle/meshcore.js";

// minimal in-memory transport
class FakeConnection extends Connection {
  async sendToRadioFrame() {}
}

const conn = new FakeConnection();
conn.on(Constants.ResponseCodes.ContactMsgRecv, (message) => {
  console.log(JSON.stringify(message.text));
  // observed:  "ޭ��hello from a room"  (author bytes mangled — 0xDE 0xAD
  //            happens to decode as U+07AD, 0xBE 0xEF become U+FFFD)
  // expected:  author prefix surfaced separately + text === "hello from a room"
});

const frame = [
  Constants.ResponseCodes.ContactMsgRecv,
  ...[1, 2, 3, 4, 5, 6],            // pubKeyPrefix (room server)
  0xff,                             // pathLen
  Constants.TxtTypes.SignedPlain,   // txtType = 2
  ...[0x00, 0x00, 0x00, 0x00],      // senderTimestamp
  ...[0xde, 0xad, 0xbe, 0xef],      // 4 raw author pubkey bytes (not UTF-8!)
  ...Buffer.from("hello from a room", "utf-8"),
];
conn.onFrameReceived(frame);
```

## Suggested fix

When `txtType === Constants.TxtTypes.SignedPlain`, read the 4 bytes before the
text and expose them (e.g. `signedAuthorPrefix`, hex-encoded), leaving `text`
clean:

```js
const txtType = bufferReader.readByte();
const senderTimestamp = bufferReader.readUInt32LE();
const signedAuthorPrefix = txtType === Constants.TxtTypes.SignedPlain
    ? BufferUtils.bytesToHex(bufferReader.readBytes(4))
    : null;
const text = bufferReader.readString();
```

Happy to send a PR if the shape looks right to you.

---

## Second ask (separate issue or same thread): ship type declarations

We hand-maintain ~300 lines of ambient `.d.ts` for the main entry and the
`src/connection/*.js` / `src/constants.js` / `src/buffer_utils.js` subpaths.
If the package shipped its own `types` (even a generated `index.d.ts`), we —
and presumably other TS consumers — could delete ours and pin the minimum
version. Also happy to contribute this.
