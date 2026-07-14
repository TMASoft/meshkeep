import { MockRadio } from "./mock-radio.js";

const port = Number.parseInt(process.env.MOCK_RADIO_PORT ?? "5100", 10);
const mock = new MockRadio({ port, log: (line) => console.log(`[mock-radio] ${line}`) });

await mock.start();
console.log(`[mock-radio] point the server at it with:`);
console.log(`  MESHKEEP_CONNECTION=tcp MESHKEEP_TCP_HOST=127.0.0.1 MESHKEEP_TCP_PORT=${mock.port}`);

// stdin lines starting with "dm <name> <text>" or "ch <idx> <text>" inject traffic
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const dmMatch = trimmed.match(/^dm\s+(\S+(?:\s\S+)*?)\s*::\s*(.+)$/) ?? trimmed.match(/^dm\s+(\S+)\s+(.+)$/);
      const chMatch = trimmed.match(/^ch\s+(\d+)\s+(.+)$/);
      if (dmMatch) {
        mock.injectDirectMessage(dmMatch[1], dmMatch[2]);
        console.log(`[mock-radio] injected DM from ${dmMatch[1]}`);
      } else if (chMatch) {
        mock.injectChannelMessage(Number(chMatch[1]), chMatch[2]);
        console.log(`[mock-radio] injected channel message`);
      } else {
        console.log(`[mock-radio] usage: dm <contact name> :: <text> | ch <idx> <text>`);
      }
    } catch (error) {
      console.log(`[mock-radio] ${String(error)}`);
    }
  }
});
