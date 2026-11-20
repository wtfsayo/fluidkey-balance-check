import { parseArgs } from "node:util";
import { plainReport, type ScanState } from "./report";
import { CHAINS, fetchPrices, printable, type Safe, scanChain } from "./scan";
import { openTui } from "./tui";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: { from: { type: "string", default: "0" }, to: { type: "string" }, browser: { type: "boolean" } },
});
const [wallet] = positionals;
const start = Number(values.from);
const end = values.to === undefined ? undefined : Number(values.to);
const validRange = Number.isInteger(start) && start >= 0 && (end === undefined || (Number.isInteger(end) && end > start));
if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet) || !validRange) {
  console.error("Usage: bun check.ts <wallet address> [--from 0] [--to <index>] [--browser]");
  process.exit(1);
}

// A Fluidkey signature can produce the spending key, so it never enters this process. The signing
// step pipes it straight into derive.ts, which answers with a key that can list Safes but not spend.
// Both are sandboxed against writing to disk, and derive.ts against using the network.
const NO_DISK = "(version 1)(allow default)(deny file-write*)";
const OFFLINE = `${NO_DISK}(deny network*)`;
const SIGN_INTO_VIEW_KEY =
  'set -o pipefail; sandbox-exec -p "$0" bun "$1" | sandbox-exec -p "$2" bun derive.ts view-key "$3" "$4"';
// Fluidkey hands out indexes in order, so the scan stops after this many in a row are unused.
const BATCH = 500;

const derive = (...args: string[]) => ["sandbox-exec", "-p", OFFLINE, "bun", "derive.ts", ...args];

async function run(command: string[], input: string): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: import.meta.dir,
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "inherit",
  });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) process.exit(1);
  return output;
}

function promptHidden(label: string): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  let typed = "";
  const onData = (chunk: Buffer) => {
    for (const char of chunk.toString()) {
      if (char === "\u0003") process.exit(130);
      if (char === "\r" || char === "\n") {
        process.stdin.off("data", onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        resolve(typed);
        return;
      }
      typed = char === "\u007f" ? typed.slice(0, -1) : typed + char;
    }
  };
  process.stdin.setRawMode(true);
  process.stdout.write(label);
  process.stdin.resume();
  process.stdin.on("data", onData);
  return promise;
}

const pin = await promptHidden("Fluidkey PIN (4 digits, hidden; 0000 if you never set one): ");
if (!/^\d{4}$/.test(pin)) {
  console.error("The PIN is 4 digits.");
  process.exit(1);
}
const message = await run(derive("message", wallet), JSON.stringify({ pin }));
const projectId = process.env.WALLETCONNECT_PROJECT_ID;
const signer = values.browser || !projectId ? "sign-browser.ts" : "sign-walletconnect.ts";
const viewKey = await run(
  ["bash", "-c", SIGN_INTO_VIEW_KEY, NO_DISK, signer, OFFLINE, wallet, message],
  JSON.stringify({ address: wallet, message, projectId }),
);

const state: ScanState = {
  wallet,
  checked: { from: start, to: start },
  chains: new Map(CHAINS.map(({ name }) => [name, { deployed: [], failures: [] }])),
  holdings: [],
  prices: new Map(),
};
const ui = process.stdout.isTTY ? openTui(state) : undefined;
ui?.closed.then(finish);

function finish() {
  if (state.checking) console.log("Stopped before the scan finished.");
  console.log(plainReport(state));
  const incomplete = state.checking || [...state.chains.values()].some(({ failures }) => failures.length > 0);
  process.exit(incomplete ? 1 : 0);
}

for (let from = start; ; from += BATCH) {
  const to = end === undefined ? from + BATCH : Math.min(from + BATCH, end);
  state.checking = { from, to, waitingFor: new Set(CHAINS.map(({ name }) => name)) };
  ui?.refresh();
  const safes: Safe[] = JSON.parse(await run(derive("safes", String(from), String(to)), viewKey));

  let inUse = false;
  await Promise.all(
    CHAINS.map(async (chain) => {
      const status = state.chains.get(chain.name)!;
      try {
        const { holdings, deployed } = await scanChain(chain, safes);
        state.holdings.push(...holdings);
        status.deployed.push(...deployed);
        inUse ||= holdings.length > 0 || deployed.length > 0;
      } catch (error) {
        const { shortMessage, message } = error as Error & { shortMessage?: string };
        status.failures.push({ from, to, error: printable(shortMessage ?? message) });
      }
      state.checking!.waitingFor.delete(chain.name);
      ui?.refresh();
    }),
  );

  const unpriced = [...new Set(state.holdings.map(({ priceKey }) => priceKey))].filter((key) => !state.prices.has(key));
  try {
    for (const [key, price] of await fetchPrices(unpriced)) state.prices.set(key, price);
    state.pricesError = undefined;
  } catch (error) {
    state.pricesError = (error as Error).message;
  }
  state.checked.to = to;
  if (end === undefined ? !inUse : to >= end) break;
}

state.checking = undefined;
if (ui) ui.refresh();
else finish();
