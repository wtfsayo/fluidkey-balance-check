import { SignClient } from "@walletconnect/sign-client";
import { renderUnicodeCompact } from "uqr";
import { type Address, type Hex, toHex } from "viem";

// stdout carries only the signature; everything the user reads goes to stderr.
const { address, message, projectId }: { address: Address; message: string; projectId: string } =
  await Bun.stdin.json();

const client = await SignClient.init({
  projectId,
  logger: "silent",
  // Pairing keys stay in memory; the default writes them to a file in the working directory.
  storageOptions: { database: ":memory:" },
  metadata: {
    name: "Fluidkey balance check",
    description: "Read-only balance check for Fluidkey stealth accounts",
    url: "https://github.com/wtfsayo/fluidkey-balance-check",
    icons: [],
  },
});

const { uri, approval } = await client.connect({
  optionalNamespaces: { eip155: { chains: ["eip155:1"], methods: ["personal_sign"], events: [] } },
});
console.error(renderUnicodeCompact(uri!, { border: 2 }));
console.error(`Scan with your wallet app, or paste this link into it:\n${uri}\n`);

const session = await approval();
// The wallet chooses these strings, so only well-formed ones are compared or printed.
const accounts = Object.values(session.namespaces)
  .flatMap((namespace) => namespace.accounts)
  .filter((caip10) => /^eip155:\d+:0x[0-9a-fA-F]{40}$/.test(caip10));
const account = accounts.find((caip10) => caip10.toLowerCase().endsWith(`:${address.toLowerCase()}`));
const disconnect = () => client.disconnect({ topic: session.topic, reason: { code: 6000, message: "Done" } });
if (!account) {
  await disconnect();
  const connected = accounts[0]?.split(":")[2] ?? "an account this tool does not recognise";
  console.error(`Your wallet connected as ${connected}. Switch it to ${address} and run this again.`);
  process.exit(1);
}

console.error("Connected. Approve the message signature in your wallet…");
const signature = await client.request<Hex>({
  topic: session.topic,
  chainId: account.split(":").slice(0, 2).join(":"),
  request: { method: "personal_sign", params: [toHex(message), address] },
});
await disconnect();
process.stdout.write(signature);
process.exit(0);
