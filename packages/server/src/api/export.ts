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

/** The CSV header line, terminated with CRLF, for streaming exports. */
export function csvHeaderRow(): string {
  return `${CSV_COLUMNS.join(",")}\r\n`;
}

/** One message rendered as a CRLF-terminated CSV row (formula-neutralized). */
export function messageToCsvRow(message: Message): string {
  const counterparty =
    message.kind === "dm"
      ? message.contactName ?? message.contactKey
      : message.channelName ?? `channel ${message.channelIdx}`;
  return `${[
    csvField(message.id),
    csvField(message.kind),
    csvField(message.direction),
    csvField(counterparty),
    csvField(message.contactKey),
    csvField(message.channelIdx),
    csvField(message.text),
    csvField(new Date(message.senderTimestamp * 1000).toISOString()),
    csvField(message.status),
  ].join(",")}\r\n`;
}

export function messagesToCsv(messages: Message[]): string {
  let out = csvHeaderRow();
  for (const message of messages) out += messageToCsvRow(message);
  return out;
}
