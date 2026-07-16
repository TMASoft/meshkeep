import type { Message } from "@meshkeep/shared";

export interface DisplayMessage {
  sender: string | null;
  text: string;
}

function shortKey(key: string): string {
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

export function displayMessage(message: Message): DisplayMessage {
  if (message.kind === "channel" && message.direction === "in") {
    const sender = message.authorName ?? (message.authorPrefix ? shortKey(message.authorPrefix) : null) ?? message.contactName;
    if (sender) return { sender, text: message.text };

    // Unsigned channel frames commonly carry the sender name as "Name: message".
    const inline = message.text.match(/^([^:\n/]{1,30}):[ \t]+(.+)$/s);
    if (inline && !/^\s/.test(inline[1]!)) {
      return { sender: inline[1]!.trim(), text: inline[2]!.trim() };
    }
    return { sender: "Unknown sender", text: message.text };
  }

  if (message.authorPrefix) {
    return { sender: message.authorName ?? shortKey(message.authorPrefix), text: message.text };
  }
  return { sender: null, text: message.text };
}
