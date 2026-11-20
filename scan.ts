import {
  type Abi,
  type Address,
  BaseError,
  ContractFunctionZeroDataError,
  createPublicClient,
  erc20Abi,
  formatUnits,
  http,
  parseAbi,
} from "viem";
import tokenList from "./tokens.json";

export type Safe = { index: number; setup: string; address: Address };
type Chain = { id: number; name: string; native: string; rpc: string; priceChain: string; nativePrice: string };
type Call = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] };
/** `amount` is in units of `asset`; vault shares are converted to the asset they redeem for. */
export type Holding = { chain: string; safe: Safe; amount: number; asset: string; heldAs?: string; priceKey: string };
type Reader = (calls: Call[]) => Promise<unknown[]>;

// priceChain and nativePrice are DefiLlama price identifiers.
export const CHAINS: Chain[] = [
  { id: 1, name: "Ethereum", native: "ETH", rpc: "https://ethereum-rpc.publicnode.com", priceChain: "ethereum", nativePrice: "coingecko:ethereum" },
  { id: 8453, name: "Base", native: "ETH", rpc: "https://base-rpc.publicnode.com", priceChain: "base", nativePrice: "coingecko:ethereum" },
  { id: 42161, name: "Arbitrum", native: "ETH", rpc: "https://arbitrum-one-rpc.publicnode.com", priceChain: "arbitrum", nativePrice: "coingecko:ethereum" },
  { id: 10, name: "Optimism", native: "ETH", rpc: "https://optimism-rpc.publicnode.com", priceChain: "optimism", nativePrice: "coingecko:ethereum" },
  { id: 137, name: "Polygon", native: "POL", rpc: "https://polygon-bor-rpc.publicnode.com", priceChain: "polygon", nativePrice: "coingecko:polygon-ecosystem-token" },
  { id: 100, name: "Gnosis", native: "xDAI", rpc: "https://gnosis-rpc.publicnode.com", priceChain: "xdai", nativePrice: "coingecko:xdai" },
  { id: 56, name: "BNB Chain", native: "BNB", rpc: "https://bsc-rpc.publicnode.com", priceChain: "bsc", nativePrice: "coingecko:binancecoin" },
  { id: 43114, name: "Avalanche", native: "AVAX", rpc: "https://avalanche-c-chain-rpc.publicnode.com", priceChain: "avax", nativePrice: "coingecko:avalanche-2" },
  { id: 146, name: "Sonic", native: "S", rpc: "https://sonic-rpc.publicnode.com", priceChain: "sonic", nativePrice: "coingecko:sonic-3" },
];
const MULTICALL3: Address = "0xca11bde05977b3631167028862be2a173976ca11";
// Fluidkey's auto-earn Safe modules: v1.0, then v1.1 onwards.
const EARN_MODULES: Address[] = [
  "0x74995e1075f1b0c308efacc56520d14e4954da6f",
  "0x3bdb857afe9b51d8916d80240d2ade40d4d3f2f9",
];
// Polygon's public RPC rejects 2,000 balance reads in one eth_call; 500 passes on all nine chains.
const CALLS_PER_REQUEST = 500;
const PARALLEL_REQUESTS = 8;

const abi = parseAbi([
  "function getEthBalance(address) view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function getAllConfigs(address) view returns ((address token, address vault)[])",
  "function convertToAssets(uint256) view returns (uint256)",
  "function asset() view returns (address)",
  "function getBlockNumber() view returns (uint256)",
]);

/**
 * Results line up with `calls`. A call to an address with no contract yields undefined; any
 * other failed call throws, so a Safe is never taken for undeployed because a read went wrong.
 * An RPC that rejects a whole request reports every call in it as failed, so each request
 * ends with one call that cannot fail on its own.
 */
function reader(chain: Chain): Reader {
  const client = createPublicClient({ transport: http(process.env[`RPC_${chain.id}`] ?? chain.rpc) });
  const canary: Call = { address: MULTICALL3, abi, functionName: "getBlockNumber" };
  const request = async (calls: Call[]) => {
    const results = await client.multicall({
      contracts: [...calls, canary],
      multicallAddress: MULTICALL3,
      batchSize: Number.MAX_SAFE_INTEGER,
    });
    const canaryResult = results[calls.length];
    if (canaryResult.status === "failure") throw canaryResult.error;
    return results.slice(0, calls.length).map((call) => {
      if (call.status === "success") return call.result;
      const noContract = call.error instanceof BaseError && call.error.walk((cause) => cause instanceof ContractFunctionZeroDataError);
      if (!noContract) throw call.error;
      return undefined;
    });
  };
  return async (calls) => {
    const requests = Array.from({ length: Math.ceil(calls.length / CALLS_PER_REQUEST) }, (_, i) =>
      calls.slice(i * CALLS_PER_REQUEST, (i + 1) * CALLS_PER_REQUEST),
    );
    const results: unknown[][] = [];
    let next = 0;
    const worker = async () => {
      while (next < requests.length) {
        const i = next++;
        results[i] = await request(requests[i]);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL_REQUESTS }, worker));
    return results.flat();
  };
}

/** Text from an RPC ends up on the terminal, where control characters could rewrite the screen. */
export const printable = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

async function tokenMetadata(read: Reader, tokens: Address[]) {
  const fields = await read(
    tokens.flatMap((address) => [
      { address, abi: erc20Abi, functionName: "symbol" },
      { address, abi: erc20Abi, functionName: "decimals" },
    ]),
  );
  const metadata = new Map<Address, { symbol: string; decimals: number }>();
  tokens.forEach((address, i) => {
    const [symbol, decimals] = [fields[2 * i], fields[2 * i + 1]];
    if (typeof symbol === "string" && typeof decimals === "number") {
      metadata.set(address, { symbol: printable(symbol), decimals });
    }
  });
  return metadata;
}

export async function scanChain(chain: Chain, safes: Safe[]): Promise<{ holdings: Holding[]; deployed: Safe[] }> {
  const read = reader(chain);

  const thresholds = await read(safes.map((safe) => ({ address: safe.address, abi, functionName: "getThreshold" })));
  const deployed = new Set(safes.filter((_, i) => thresholds[i] !== undefined));

  const configs = (await read(
    [...deployed].flatMap((safe) =>
      EARN_MODULES.map((address) => ({ address, abi, functionName: "getAllConfigs", args: [safe.address] })),
    ),
  )) as ({ vault: Address }[] | undefined)[];
  const vaults = [...new Set(configs.flatMap((config) => config ?? []).map(({ vault }) => vault.toLowerCase() as Address))];
  const underlying = ((await read(vaults.map((address) => ({ address, abi, functionName: "asset" })))) as Address[]).map(
    (token) => token.toLowerCase() as Address,
  );

  const listed = ((tokenList as Record<string, Address[]>)[chain.id] ?? []).filter((token) => !vaults.includes(token));
  const metadata = await tokenMetadata(read, [...listed, ...vaults, ...underlying]);
  const missing = listed.find((token) => !metadata.has(token));
  if (missing) throw new Error(`${missing} in tokens.json is not an ERC-20 token on ${chain.name}`);

  // Vault shares only exist in deployed Safes: the auto-earn module cannot act on an undeployed one.
  const positions = safes.flatMap((safe) => [
    { safe, token: undefined },
    ...listed.map((token) => ({ safe, token })),
    ...(deployed.has(safe) ? vaults.map((token) => ({ safe, token })) : []),
  ]);
  const balances = (await read(
    positions.map(({ safe, token }) =>
      token
        ? { address: token, abi: erc20Abi, functionName: "balanceOf", args: [safe.address] }
        : { address: MULTICALL3, abi, functionName: "getEthBalance", args: [safe.address] },
    ),
  )) as (bigint | undefined)[];
  if (balances.includes(undefined)) throw new Error("a balance read failed");
  const held = positions.flatMap((position, i) => (balances[i] ? [{ ...position, balance: balances[i] }] : []));

  const shares = held.filter(({ token }) => token && vaults.includes(token));
  const assets = (await read(
    shares.map(({ token, balance }) => ({ address: token!, abi, functionName: "convertToAssets", args: [balance] })),
  )) as bigint[];

  const holdings = held.map((position) => {
    const { safe, token, balance } = position;
    const holding = { chain: chain.name, safe };
    if (!token) {
      return { ...holding, amount: Number(formatUnits(balance, 18)), asset: chain.native, priceKey: chain.nativePrice };
    }
    const share = shares.indexOf(position);
    if (share === -1) {
      const { symbol, decimals } = metadata.get(token)!;
      const priceKey = `${chain.priceChain}:${token}`;
      return { ...holding, amount: Number(formatUnits(balance, decimals)), asset: symbol, priceKey };
    }
    const underlyingToken = underlying[vaults.indexOf(token)];
    const asset = metadata.get(underlyingToken)!;
    return {
      ...holding,
      amount: Number(formatUnits(assets[share], asset.decimals)),
      asset: asset.symbol,
      heldAs: metadata.get(token)!.symbol,
      priceKey: `${chain.priceChain}:${underlyingToken}`,
    };
  });
  return { holdings, deployed: [...deployed] };
}

/** USD prices from DefiLlama, keyed as in `Holding.priceKey`. Assets it does not know are absent. */
export async function fetchPrices(priceKeys: string[]): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  for (let start = 0; start < priceKeys.length; start += 50) {
    const response = await fetch(`https://coins.llama.fi/prices/current/${priceKeys.slice(start, start + 50).join(",")}`);
    if (!response.ok) throw new Error(`price lookup failed with HTTP ${response.status}`);
    const { coins }: { coins: Record<string, { price: number }> } = await response.json();
    for (const [key, { price }] of Object.entries(coins)) prices.set(key.toLowerCase(), price);
  }
  return prices;
}
