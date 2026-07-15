import type { Message } from "@meshkeep/shared";

const CSV_COLUMNS = [
  "id",
  "kind",
  "direction",
  "counterparty",
  "contact_key",
  "channel_idx",
  "text",
  "sender_time_utc",
  "status",
] as const;

function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  // mesh peers control message text: neutralize spreadsheet formula injection
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

export function messagesToCsv(messages: Message[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const message of messages) {
    const counterparty =
      message.kind === "dm"
        ? message.contactName ?? message.contactKey
        : message.channelName ?? `channel ${message.channelIdx}`;
    lines.push(
      [
        csvField(message.id),
        csvField(message.kind),
        csvField(message.direction),
        csvField(counterparty),
        csvField(message.contactKey),
        csvField(message.channelIdx),
        csvField(message.text),
        csvField(new Date(message.senderTimestamp * 1000).toISOString()),
        csvField(message.status),
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}
