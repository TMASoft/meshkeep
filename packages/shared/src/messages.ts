// MeshCore group texts (GRP_TXT) embed the sender in the encrypted payload as
// "name: msg" — composed by the sending firmware, passed through verbatim on
// receive (see upstream packet.js PAYLOAD_TYPE_GRP_TXT). Channel messages
// carry no contact mapping otherwise, so this inline prefix is the only
// sender identity they have.

export interface InlineSender {
  sender: string;
  text: string;
}

// node names are capped at 31 chars (companion firmware advert name limit)
const INLINE_SENDER_RE = /^([^:\n]{1,31}): (.+)$/s;

/**
 * Split a "name: msg" channel text into sender and body. Returns null when
 * the text doesn't follow the convention — callers should then fall back to
 * their existing unknown-sender rendering. Requires the literal ": "
 * separator so URLs ("https://…") and bare colons never false-positive.
 */
export function parseInlineSender(text: string): InlineSender | null {
  const match = INLINE_SENDER_RE.exec(text);
  if (!match) return null;
  const sender = match[1]!.trim();
  const body = match[2]!.trim();
  if (!sender || !body || sender.includes("/")) return null;
  return { sender, text: body };
}
