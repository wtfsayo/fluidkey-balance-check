import { SignClient } from "@walletconnect/sign-client";
import { renderUnicodeCompact } from "uqr";
import { type Address, type Hex, isAddressEqual, toHex } from "viem";

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
    url: "https://github.com/fluidkey/fluidkey-stealth-account-kit",
    icons: [],
  },
});

const { uri, approval } = await client.connect({
  optionalNamespaces: { eip155: { chains: ["eip155:1"], methods: ["personal_sign"], events: [] } },
});
console.error(renderUnicodeCompact(uri!, { border: 2 }));
console.error(`Scan with your wallet app, or paste this link into it:\n${uri}\n`);

const session = await approval();
const accounts = Object.values(session.namespaces).flatMap((namespace) => namespace.accounts);
const account = accounts.find((caip10) => isAddressEqual(caip10.split(":")[2] as Address, address));
const disconnect = () => client.disconnect({ topic: session.topic, reason: { code: 6000, message: "Done" } });
if (!account) {
  await disconnect();
  console.error(`Your wallet connected as ${accounts[0]?.split(":")[2]}. Switch it to ${address} and run this again.`);
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
