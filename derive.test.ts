import { expect, test } from "bun:test";
import { generateKeysFromSignature, predictStealthSafeAddressWithBytecode } from "@fluidkey/stealth-account-kit";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import params from "./fluidkey-params.json";

// The public test key from the stealth-account-kit test suite. Never send funds to it.
const wallet = privateKeyToAccount("0x8575420a19052cf9bbe9ef4ac755a9abaaefa3f1f2e35d14c04f38829182e9ba");
const pin = "1234";

async function derive(args: string[], input: string) {
  const child = Bun.spawn(["bun", "derive.ts", ...args], {
    cwd: import.meta.dir,
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  return { stdout, exitCode: await child.exited };
}

async function signedMessage(signer = wallet) {
  const { stdout: message } = await derive(["message", wallet.address], JSON.stringify({ pin }));
  return { message, signature: await signer.signMessage({ message }) };
}

test("reproduces the addresses published in the kit's tests", async () => {
  const { message, signature } = await signedMessage();
  const { stdout: viewKey } = await derive(["view-key", wallet.address, message], signature);
  const { stdout } = await derive(["safes", "0", "3"], viewKey);
  const safes: { index: number; setup: string; address: string }[] = JSON.parse(stdout);

  expect(safes.filter(({ setup }) => setup === "manual").map(({ address }) => address)).toEqual([
    "0xf08954409c41f6823bdd1f14e239b5ae9c5c9c5d",
    "0x25016e8527ff0198bfc6a6bba2f1f128d58df45c",
    "0xfa233664f0d087ad9efee5e45fd409febd6bdc0c",
  ]);
  expect(new Set(safes.map(({ address }) => address)).size).toBe(3 * params.setups.length);
});

test("the view key carries neither the signature nor the spending key", async () => {
  const { message, signature } = await signedMessage();
  const { stdout: viewKey } = await derive(["view-key", wallet.address, message], signature);
  const { spendingPrivateKey } = generateKeysFromSignature(signature);

  expect(Object.keys(JSON.parse(viewKey)).sort()).toEqual(["spendingPublicKey", "viewingKeyNode"]);
  expect(viewKey).not.toContain(spendingPrivateKey.slice(2));
  expect(viewKey).not.toContain(signature.slice(2, 66));
});

test("rejects a signature made by a different wallet", async () => {
  const { message, signature } = await signedMessage(privateKeyToAccount(`0x${"11".repeat(32)}`));
  const { stdout, exitCode } = await derive(["view-key", wallet.address, message], signature);

  expect(exitCode).toBe(1);
  expect(stdout).toBe("");
});

test("auto-earn parameters reproduce a Safe that Fluidkey deployed", () => {
  // 0x3A25…2DC6 on Ethereum mainnet has the single owner 0x3f66…3330 and the earn module enabled.
  const setup = params.setups.find(({ id }) => id === "auto-earn-core-v1-2")!;
  const { stealthSafeAddress } = predictStealthSafeAddressWithBytecode({
    safeProxyBytecode: params.safeProxyBytecode as Hex,
    threshold: 1,
    stealthAddresses: ["0x3f6625b8f1107e60fba3142f509328cdf6403330"],
    useDefaultAddress: true,
    safeVersion: "1.3.0",
    initializerExtraFields: { to: setup.to as Hex, data: setup.data as Hex },
  });

  expect(stealthSafeAddress).toBe("0x3a256ffceed08a9921aeca30960ff6301cf22dc6");
});
