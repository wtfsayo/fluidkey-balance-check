import params from "./fluidkey-params.json";
import { CHAINS, type Holding, type Safe } from "./scan";

/** `to` is exclusive. */
export type IndexRange = { from: number; to: number };
export type ScanState = {
  wallet: string;
  checked: IndexRange;
  checking?: IndexRange & { waitingFor: Set<string> };
  chains: Map<string, { deployed: Safe[]; failures: (IndexRange & { error: string })[] }>;
  holdings: Holding[];
  prices: Map<string, number>;
  pricesError?: string;
};
export type Line = { text: string; kind?: "title" | "head" | "dim" | "warn" | "bad" };
type UsedSafe = { safe: Safe; deployedOn: string[]; holdings: Holding[] };
export type Summary = {
  /** Sorted by index. */
  safes: UsedSafe[];
  /** Holdings without a price count as zero. */
  usdValue: (holdings: Holding[]) => number;
  isPriced: (holding: Holding) => boolean;
  total: number;
  unpriced: string[];
};

const amountFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
const usdFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const formatAmount = (amount: number) => (amount < 0.000001 ? "<0.000001" : amountFormat.format(amount));
const formatUsd = (value: number) => usdFormat.format(value);
const formatRange = ({ from, to }: IndexRange) => (to - from === 1 ? String(from) : `${from}–${to - 1}`);
const profileLabel = (setup: string) =>
  setup === "manual" ? "No auto-earn" : params.setups.find(({ id }) => id === setup)!.label;

/** A Safe is in use once it is deployed on any chain or holds anything. */
export function summarize(state: ScanState): Summary {
  const isPriced = ({ priceKey }: Holding) => state.prices.has(priceKey);
  const usdValue = (holdings: Holding[]) =>
    holdings.reduce((total, holding) => total + (state.prices.get(holding.priceKey) ?? 0) * holding.amount, 0);

  const byAddress = new Map<string, UsedSafe>();
  const entry = (safe: Safe) => {
    if (!byAddress.has(safe.address)) byAddress.set(safe.address, { safe, deployedOn: [], holdings: [] });
    return byAddress.get(safe.address)!;
  };
  for (const [chain, { deployed }] of state.chains) for (const safe of deployed) entry(safe).deployedOn.push(chain);
  const chainOrder = CHAINS.map(({ name }) => name);
  const holdings = state.holdings.toSorted((a, b) => chainOrder.indexOf(a.chain) - chainOrder.indexOf(b.chain));
  for (const holding of holdings) entry(holding.safe).holdings.push(holding);

  return {
    safes: [...byAddress.values()].sort((a, b) => a.safe.index - b.safe.index),
    usdValue,
    isPriced,
    total: usdValue(state.holdings),
    unpriced: [...new Set(state.holdings.filter((holding) => !isPriced(holding)).map(({ asset }) => asset))],
  };
}

function table(head: string[], rows: string[][], rightAligned: number[], empty: string): Line[] {
  if (rows.length === 0) return [{ text: empty, kind: "dim" }];
  const widths = head.map((cell, column) => rows.reduce((width, row) => Math.max(width, row[column].length), cell.length));
  const format = (row: string[]) =>
    row
      .map((cell, column) => (rightAligned.includes(column) ? cell.padStart(widths[column]) : cell.padEnd(widths[column])))
      .join("  ")
      .trimEnd();
  return [{ text: format(head), kind: "head" }, ...rows.map((row) => ({ text: format(row) }))];
}

export function assetLines(state: ScanState, summary: Summary): Line[] {
  const assets = Map.groupBy(state.holdings, ({ asset }) => asset);
  const rows = [...assets]
    .map(([asset, holdings]) => ({
      asset,
      amount: holdings.reduce((total, { amount }) => total + amount, 0),
      usd: holdings.every(summary.isPriced) ? summary.usdValue(holdings) : undefined,
    }))
    .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
  return table(
    ["Asset", "Amount", "USD"],
    rows.map(({ asset, amount, usd }) => [asset, formatAmount(amount), usd === undefined ? "–" : formatUsd(usd)]),
    [1, 2],
    state.checking ? "Nothing found yet." : "No balances found.",
  );
}

export function profileLines(state: ScanState, summary: Summary): Line[] {
  const profiles = Map.groupBy(summary.safes, ({ safe }) => safe.setup);
  const rows = params.setups
    .filter(({ id }) => profiles.has(id))
    .map(({ id }) => {
      const safes = profiles.get(id)!;
      const funded = safes.filter(({ holdings }) => holdings.length > 0);
      return [
        profileLabel(id),
        formatRange({ from: safes[0].safe.index, to: safes.at(-1)!.safe.index + 1 }),
        String(safes.length),
        String(funded.length),
        formatUsd(summary.usdValue(funded.flatMap(({ holdings }) => holdings))),
      ];
    });
  return table(["Auto-earn profile", "Indexes", "Safes", "Funded", "USD"], rows, [1, 2, 3, 4], state.checking ? "Nothing found yet." : "No Safes in use found.");
}

export function chainLines(state: ScanState, summary: Summary): Line[] {
  const rows = CHAINS.map(({ name }) => {
    const { deployed, failures } = state.chains.get(name)!;
    const holdings = state.holdings.filter(({ chain }) => chain === name);
    const status =
      failures.length > 0
        ? `NOT CHECKED for indexes ${failures.map(formatRange).join(", ")}: ${failures[0].error}`
        : state.checking?.waitingFor.has(name)
          ? `checking ${formatRange(state.checking)}…`
          : "checked";
    return [
      name,
      String(deployed.length),
      String(new Set(holdings.map(({ safe }) => safe.address)).size),
      formatUsd(summary.usdValue(holdings)),
      status,
    ];
  });
  return table(["Chain", "Deployed", "Funded", "USD", "Status"], rows, [1, 2, 3], "");
}

/** The address comes last so that a narrow terminal cuts it off before the amounts. */
export function safeLines(summary: Summary, hideEmpty: boolean): Line[] {
  const rows = summary.safes.flatMap(({ safe, deployedOn, holdings }) => {
    const identity = [String(safe.index), profileLabel(safe.setup).replace(/ \(.*/, "")];
    if (holdings.length === 0) {
      return hideEmpty ? [] : deployedOn.map((chain) => [...identity, chain, "", "empty", "", "", safe.address]);
    }
    return holdings.map((holding) => [
      ...identity,
      holding.chain,
      formatAmount(holding.amount),
      holding.asset,
      summary.isPriced(holding) ? formatUsd(summary.usdValue([holding])) : "–",
      holding.heldAs ?? "",
      safe.address,
    ]);
  });
  return table(
    ["Index", "Profile", "Chain", "Amount", "Asset", "USD", "Held as", "Safe"],
    rows,
    [0, 3, 5],
    "No Safes in use found.",
  );
}

export function statusLine(state: ScanState): Line {
  if (state.checking) {
    const done = CHAINS.length - state.checking.waitingFor.size;
    return { text: `Checking indexes ${formatRange(state.checking)}: ${done} of ${CHAINS.length} chains done…`, kind: "warn" };
  }
  const failed = [...state.chains].filter(([, { failures }]) => failures.length > 0).map(([chain]) => chain);
  if (failed.length > 0) {
    const text = `Incomplete: ${failed.join(", ")} could not be checked, so the scan may also have stopped early. Run it again.`;
    return { text, kind: "bad" };
  }
  return { text: `Checked indexes ${formatRange(state.checked)} on all ${CHAINS.length} chains.` };
}

export function noteLines(state: ScanState, summary: Summary): Line[] {
  const notes: Line[] = [];
  if (summary.unpriced.length > 0) {
    notes.push({ text: `No price for ${summary.unpriced.join(", ")}; the USD totals leave them out.`, kind: "warn" });
  }
  if (state.pricesError) notes.push({ text: `USD values are missing: ${state.pricesError}.`, kind: "warn" });
  if (!state.checking && summary.safes.length === 0) {
    notes.push({ text: "Nothing found. A wrong PIN gives a different, empty set of addresses." });
  }
  notes.push({
    text: "Covers native coins, the tokens in tokens.json and Fluidkey auto-earn vaults. Other tokens are not shown.",
    kind: "dim",
  });
  return notes;
}

export function headline(summary: Summary): string {
  const funded = summary.safes.filter(({ holdings }) => holdings.length > 0).length;
  return `${formatUsd(summary.total)} in ${funded} of ${summary.safes.length} Safes in use`;
}

export function plainReport(state: ScanState): string {
  const summary = summarize(state);
  const section = (title: string, lines: Line[]) => ["", title, ...lines.map(({ text }) => text)];
  return [
    `Fluidkey balances for ${state.wallet}: ${headline(summary)}`,
    statusLine(state).text,
    ...section("By asset", assetLines(state, summary)),
    ...section("By auto-earn profile", profileLines(state, summary)),
    ...section("By chain", chainLines(state, summary)),
    ...section("Safes", safeLines(summary, false)),
    "",
    ...noteLines(state, summary).map(({ text }) => text),
  ].join("\n");
}
