# fluidkey-balance-check

A terminal tool that lists every [Fluidkey](https://fluidkey.com) stealth Safe your wallet controls and what each one holds. It needs no Fluidkey app or API. It only reads: it cannot move funds, and it never prints or stores a private key.

It was written during the November 2026 Fluidkey security incident, when the app and API were offline. Fluidkey's own recovery page ([SARA](https://github.com/fluidkey/sara)) checks one auto-earn profile, one chain and one token per run. This tool checks all of them in one pass.

Not affiliated with Fluidkey. Not audited. Read [What you are trusting](#what-you-are-trusting) before you sign anything.

```
Fluidkey balances  0x547F17276D3952004eafDD0910FB47F6f2E391a0  $0.03 in 2 of 2 Safes in use
Checked indexes 0–999 on all 9 chains.

 1 Overview   2 Safes

By asset
Asset  Amount    USD
USDC     0.03  $0.03

By auto-earn profile
Auto-earn profile      Indexes  Safes  Funded    USD
No auto-earn                 0      1       1  $0.01
v1.0 (– Apr 10, 2025)        1      1       1  $0.02

By chain
Chain      Deployed  Funded    USD  Status
Ethereum          0       0  $0.00  checked
Base              0       2  $0.03  checked
...
```

## Requirements

- macOS. The tool isolates its key-handling steps with `sandbox-exec`.
- [Bun](https://bun.sh) 1.4 (tested with 1.4.4).
- The wallet you created your Fluidkey account with, and your 4-digit Fluidkey PIN (`0000` if you never set one).
- A way to sign one message with that wallet: a mobile wallet that supports WalletConnect, or a browser-extension wallet.

Accounts created with a Google, Apple or email login are not supported, because there is no wallet you can sign with outside the Fluidkey app.

## Install

```sh
git clone https://github.com/wtfsayo/fluidkey-balance-check
cd fluidkey-balance-check
bun install --frozen-lockfile
```

To sign with a mobile wallet, get a free project ID from [Reown](https://dashboard.reown.com) and put it in `.env`:

```sh
cp .env.example .env
```

## Usage

```sh
bun check.ts 0xYourWalletAddress
```

1. Type your PIN. Nothing shows as you type.
2. Scan the QR code with your wallet app and approve the message signature. It is a signature, not a transaction: no gas, no amount.
3. Wait for the scan. A typical account takes under a minute.

Keys: `Tab` switches between the overview and the list of Safes, arrows scroll, `h` hides emptied Safes, `q` quits. Quitting prints the same report as plain text.

| Option | Effect |
| --- | --- |
| `--browser` | Sign in a browser-extension wallet through a page served on `127.0.0.1`, instead of WalletConnect. |
| `--to <index>` | Check indexes up to this one, instead of stopping automatically. |
| `--from <index>` | Start at this index. Default `0`. |
| `RPC_<chainId>=<url>` | Use your own RPC for a chain, for example `RPC_8453=https://...` for Base. |

The exit code is non-zero when any chain could not be checked.

## How it works

1. `derive.ts` builds Fluidkey's key-generation message from your wallet address and PIN.
2. Your wallet signs it. Fluidkey derives both the viewing key and the spending key from this one signature.
3. The signing step pipes the signature straight into `derive.ts`, which returns a view key: a node derived from your viewing key (`m/5564'/0'`), plus the public half of the spending key. According to [Fluidkey's technical walkthrough](https://docs.fluidkey.com/technical-documentation/technical-walkthrough/), that node is the only secret the Fluidkey app shares with Fluidkey's servers, and the spending key stays in the app. A view key can list your Safes and cannot spend from them.
4. For each address index, `derive.ts` uses the view key to compute the Safe address under every setup Fluidkey has used: no auto-earn, and the nine auto-earn profiles from v1.0 to v1.4. A Safe's address depends on the setup that was active when Fluidkey issued it, and nothing records which one that was, so each index has ten candidates.
5. `scan.ts` asks each chain, through Multicall3, whether each candidate is deployed, what native coin and listed tokens it holds, and what it holds in Fluidkey's auto-earn vaults. Vault shares are shown as the asset they redeem for.
6. Fluidkey hands out indexes in order. The scan covers 500 at a time and stops after 500 in a row are unused.
7. USD prices come from DefiLlama.

Chains: Ethereum, Base, Arbitrum, Optimism, Polygon, Gnosis, BNB Chain, Avalanche, Sonic.

## What you are trusting

The signature in step 2 is as sensitive as a private key. Anyone who gets it can derive your spending key. No tool can change that, because Fluidkey puts both keys in the one signature. This one keeps the exposure as small as it can.

- **This code.** It is about 1,000 lines. Read it.
- **Where the signature goes.** Two short scripts see it: the signing step (`sign-walletconnect.ts` or `sign-browser.ts`) and `derive.ts`. A pipe connects them, so the main program never holds the signature. Both run in a sandbox that blocks writing to disk, and `derive.ts` also has no network.
- **The spending key.** `derive.ts` computes it once, to take its public half, and exits. Everything else, including all the code that talks to RPCs, holds only the view key.
- **The dependencies**, pinned in `bun.lock`: `@fluidkey/stealth-account-kit` 1.1.0, `viem` 2.7.9, `@walletconnect/sign-client` 2.25.0 and `uqr` 0.1.2. With WalletConnect, that library receives the signature. Use `--browser` to keep it out of the path.
- **The constants in `fluidkey-params.json`**, copied from `fluidkey/sara` at commit `c841db0`. The tests check them against a Safe that Fluidkey deployed.
- **The network.** The RPC endpoints see every candidate address from your IP, which lets them link your Safes to each other. The defaults are public endpoints; set `RPC_<chainId>` to change them. An RPC can also lie about balances. It cannot move anything, and the text it returns is stripped of control characters before it reaches your terminal. The WalletConnect relay sees your IP and an encrypted session. DefiLlama sees token addresses only.
- **Failures are loud.** A read that goes wrong marks the whole chain `NOT CHECKED`. It is never shown as a zero balance or an undeployed Safe.

## Limits

- It shows native coins, the tokens in `tokens.json` and Fluidkey auto-earn vaults. Any other token is invisible to it. See [Adding tokens](#adding-tokens).
- A wrong PIN is not detected. It derives a different, empty set of addresses and reports nothing found.
- An account with more than 500 unused indexes in a row needs `--to`.
- When a chain cannot be checked, the scan may stop before it reaches your later Safes. Run it again, or set `RPC_<chainId>` for that chain.
- An asset DefiLlama has no price for shows `–` in the USD column and is left out of the totals.
- Profiles Fluidkey adds after v1.4 need new entries in `fluidkey-params.json`.

## Adding tokens

`tokens.json` maps a chain ID to the token contracts checked on that chain. The shipped list is the major stablecoins and assets plus the tokens seen moving through Fluidkey Safes in November 2026. To check another token, add its contract address, in lower case, under its chain ID:

```json
{
  "8453": ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "0xyourtokenaddress"]
}
```

The tool does not discover tokens on its own. That would need an indexer API on every chain, and the tool talks only to plain RPC endpoints.

## Tests

```sh
bun test
```

They check address derivation against the vectors in the kit's own test suite, the auto-earn constants against a real Safe, that the view key holds neither the signature nor the spending key, and that a malformed reply from the wallet is never echoed.

## Credits and license

MIT. Address derivation is Fluidkey's [stealth-account-kit](https://github.com/fluidkey/fluidkey-stealth-account-kit). The auto-earn constants come from [SARA](https://github.com/fluidkey/sara) by Nami Shah and Fluid Privacy SA.
