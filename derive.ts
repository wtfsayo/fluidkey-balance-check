import {
  extractViewingPrivateKeyNode,
  generateEphemeralPrivateKey,
  generateFluidkeyMessage,
  generateKeysFromSignature,
  generateStealthAddresses,
  predictStealthSafeAddressWithBytecode,
} from "@fluidkey/stealth-account-kit";
import { getAddress, type Hex, isAddressEqual, recoverMessageAddress } from "viem";
import { HDKey, privateKeyToAccount } from "viem/accounts";
import params from "./fluidkey-params.json";

/** What Fluidkey's servers hold for an account: enough to list every Safe, not enough to spend from one. */
type ViewKey = { spendingPublicKey: Hex; viewingKeyNode: string };

const [command, ...args] = Bun.argv.slice(2);
const input = await Bun.stdin.text();

if (command === "message") {
  const { pin }: { pin: string } = JSON.parse(input);
  // Fluidkey builds the message from the checksummed address its wallet connector reports.
  process.stdout.write(generateFluidkeyMessage({ pin, address: getAddress(args[0]) }).message);
}

if (command === "view-key") {
  const [wallet, message] = args;
  const signature = input.trim() as Hex;
  // An empty signature means the signing step failed and has already said why.
  if (!signature) process.exit(1);
  const signer = await recoverMessageAddress({ message, signature });
  if (!isAddressEqual(signer, getAddress(wallet))) {
    console.error(`That is not ${wallet}'s signature of the Fluidkey message for this PIN.`);
    process.exit(1);
  }
  // Fluidkey derives both keys from this one signature. The spending key exists only on the
  // next two lines, to take its public half; nothing that can spend leaves this process.
  const { spendingPrivateKey, viewingPrivateKey } = generateKeysFromSignature(signature);
  const viewKey: ViewKey = {
    spendingPublicKey: privateKeyToAccount(spendingPrivateKey).publicKey,
    viewingKeyNode: extractViewingPrivateKeyNode(viewingPrivateKey, 0).privateExtendedKey,
  };
  process.stdout.write(JSON.stringify(viewKey));
}

if (command === "safes") {
  const [from, to] = args.map(Number);
  const { spendingPublicKey, viewingKeyNode }: ViewKey = JSON.parse(input);
  const viewingPrivateKeyNode = HDKey.fromExtendedKey(viewingKeyNode);

  // A Safe's address depends on the auto-earn setup active when Fluidkey issued it,
  // which is not recorded anywhere, so every index yields one candidate per setup.
  const safes = [];
  for (let index = from; index < to; index++) {
    const { ephemeralPrivateKey } = generateEphemeralPrivateKey({
      viewingPrivateKeyNode,
      nonce: BigInt(index),
      chainId: 0,
    });
    const { stealthAddresses } = generateStealthAddresses({
      spendingPublicKeys: [spendingPublicKey],
      ephemeralPrivateKey,
    });
    for (const setup of params.setups) {
      const { stealthSafeAddress } = predictStealthSafeAddressWithBytecode({
        safeProxyBytecode: params.safeProxyBytecode as Hex,
        threshold: 1,
        stealthAddresses,
        useDefaultAddress: true,
        safeVersion: "1.3.0",
        initializerExtraFields: { to: setup.to as Hex | undefined, data: setup.data as Hex | undefined },
      });
      safes.push({ index, setup: setup.id, address: stealthSafeAddress });
    }
  }
  process.stdout.write(JSON.stringify(safes));
}
