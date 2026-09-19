// The wallet side of a buyback, on the chain the withdrawal arrives on. Reads
// go through a public RPC. The signing key is handed in only for --execute, and
// only the two transactions a buyback needs are ever signed here: an approval
// of exactly one payout to the pinned LI.FI contract, and the swap itself.
import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, formatUnits, http, keccak256, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, polygon } from "viem/chains";
import { LIFI_DIAMOND, type Quote } from "./lifi.js";
import type { SignedTx, WalletPort } from "./machine.js";
import type { BuybackVenue } from "./plan.js";

export interface SourceChain {
  chainId: number;
  chainName: string;
  /** The token a withdrawal arrives as. Six decimals on both chains. */
  token: string;
  symbol: string;
  nativeSymbol: string;
  rpcEnv: string;
  rpcDefault: string;
  explorer: string;
  chain: Chain;
}

export const SOURCE_CHAINS: Readonly<Record<BuybackVenue, SourceChain>> = {
  // Hyperliquid withdraws native USDC to Arbitrum.
  hyperliquid: { chainId: 42161, chainName: "Arbitrum", token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", symbol: "USDC", nativeSymbol: "ETH", rpcEnv: "STRATS_RPC_ARBITRUM", rpcDefault: "https://arb1.arbitrum.io/rpc", explorer: "https://arbiscan.io", chain: arbitrum },
  // Polymarket's collateral, pUSD, on Polygon. polygon-rpc.com stopped answering without a key in 2026, so the default is the one viem ships.
  polymarket: { chainId: 137, chainName: "Polygon", token: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB", symbol: "pUSD", nativeSymbol: "POL", rpcEnv: "STRATS_RPC_POLYGON", rpcDefault: "https://polygon.drpc.org", explorer: "https://polygonscan.com", chain: polygon },
};

/** What an approval costs at most, in gas units. Used only to judge whether the wallet holds enough of the gas coin. */
const APPROVE_GAS_UNITS = 100_000n;

export function rpcUrl(source: SourceChain): string {
  const raw = process.env[source.rpcEnv]?.trim() || source.rpcDefault;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${source.rpcEnv} is not a valid URL.`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error(`${source.rpcEnv} must use https.`);
  return raw;
}

export interface ChainWallet extends WalletPort {
  nativeSymbol: string;
  nativeBalance(): Promise<bigint>;
  gasPrice(): Promise<bigint>;
}

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** `signerPk` is absent in a dry run, and then nothing can be signed. */
export function chainWallet(venue: BuybackVenue, address: string, signerPk?: string): ChainWallet {
  const source = SOURCE_CHAINS[venue];
  const diamond = LIFI_DIAMOND[source.chainId];
  if (!diamond) throw new Error(`There is no pinned LI.FI contract for ${source.chainName}.`);
  const transport = http(rpcUrl(source), { timeout: 20_000, retryCount: 1 });
  const pub = createPublicClient({ chain: source.chain, transport });
  const owner = address as Hex;

  const signer = () => {
    if (!signerPk) throw new Error("This run cannot sign: it is a dry run.");
    const account = privateKeyToAccount(signerPk as Hex);
    if (!sameAddress(account.address, address)) throw new Error("The wallet key in the keystore does not match this bot's wallet address.");
    return createWalletClient({ account, chain: source.chain, transport });
  };
  const sign = async (to: string, data: Hex, nonce: number): Promise<SignedTx> => {
    const wallet = signer();
    // Estimating the gas runs the call against the chain first, so a swap that would fail is caught before anything is signed.
    const request = await wallet.prepareTransactionRequest({ to: to as Hex, data, value: 0n, nonce });
    const gas = request.gas !== undefined ? (request.gas * 13n) / 10n : undefined;
    const raw = await wallet.signTransaction({ ...request, ...(gas !== undefined ? { gas } : {}) } as Parameters<typeof wallet.signTransaction>[0]);
    return { raw, hash: keccak256(raw) };
  };

  return {
    address, chainId: source.chainId, chainName: source.chainName, sourceSymbol: source.symbol, nativeSymbol: source.nativeSymbol,
    explorerAddressUrl: `${source.explorer}/address/${address}`,
    sourceBalance: () => pub.readContract({ address: source.token as Hex, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
    allowance: () => pub.readContract({ address: source.token as Hex, abi: erc20Abi, functionName: "allowance", args: [owner, diamond as Hex] }),
    minedNonce: () => pub.getTransactionCount({ address: owner, blockTag: "latest" }),
    nextNonce: () => pub.getTransactionCount({ address: owner, blockTag: "pending" }),
    nativeBalance: () => pub.getBalance({ address: owner }),
    gasPrice: () => pub.getGasPrice(),
    // Exactly the payout, to the pinned contract. The spender is never taken from a quote.
    signApprove: (amount, nonce) => sign(source.token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [diamond as Hex, amount] }), nonce),
    signSwap: (tx: Quote["transactionRequest"], nonce) => {
      // Checked when the quote was accepted, and once more where the key is used.
      if (!sameAddress(tx.to, diamond)) throw new Error("The swap transaction is not addressed to the pinned LI.FI contract.");
      if (tx.chainId !== source.chainId) throw new Error("The swap transaction is for a different chain.");
      if (BigInt(tx.value ?? "0x0") !== 0n) throw new Error("The swap transaction would send the wallet's gas coin.");
      return sign(tx.to, tx.data as Hex, nonce);
    },
    broadcast: async (raw) => {
      await pub.sendRawTransaction({ serializedTransaction: raw as Hex });
    },
    receipt: async (hash) => {
      try {
        const receipt = await pub.getTransactionReceipt({ hash: hash as Hex });
        return receipt.status === "success" ? "success" : "reverted";
      } catch (error) {
        if (error instanceof Error && error.name === "TransactionReceiptNotFoundError") return null;
        throw error;
      }
    },
  };
}

export interface GasCheck {
  held: bigint;
  needed: bigint;
  enough: boolean;
  heldText: string;
  shortfallText: string;
}

/** Three times the quote's own gas estimate, plus an approval when one is needed. Money must never leave the venue for a wallet that cannot move it. */
export async function checkGas(wallet: ChainWallet, quote: Quote, amount: bigint): Promise<GasCheck> {
  const [held, gasPrice, allowance] = await Promise.all([wallet.nativeBalance(), wallet.gasPrice(), wallet.allowance()]);
  const quoted = quote.estimate.gasCosts.reduce((sum, gas) => sum + BigInt(gas.amount), 0n);
  const needed = quoted * 3n + (allowance >= amount ? 0n : APPROVE_GAS_UNITS * gasPrice);
  const shortfall = needed > held ? needed - held : 0n;
  // Rounded up to six decimal places, so the number can be copied.
  const step = 10n ** 12n;
  const rounded = ((shortfall + step - 1n) / step) * step;
  return { held, needed, enough: held >= needed, heldText: Number(formatUnits(held, 18)).toFixed(4), shortfallText: formatUnits(rounded, 18) };
}
