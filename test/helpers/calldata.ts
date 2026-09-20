// Calldata in LI.FI's two call shapes, for quotes in tests. The same encoding the live API returns, so the checks read it as they read a real one.
import { encodeAbiParameters, type Hex } from "viem";

const BRIDGE_DATA = {
  type: "tuple",
  components: [
    { name: "transactionId", type: "bytes32" }, { name: "bridge", type: "string" }, { name: "integrator", type: "string" }, { name: "referrer", type: "address" },
    { name: "sendingAssetId", type: "address" }, { name: "receiver", type: "address" }, { name: "minAmount", type: "uint256" },
    { name: "destinationChainId", type: "uint256" }, { name: "hasSourceSwaps", type: "bool" }, { name: "hasDestinationCall", type: "bool" },
  ],
} as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const ID = `0x${"11".repeat(32)}` as Hex;

/** A bridge call. With `token` and `minOut` the token minimum is written into it, as Mayan and Squid do; without, it is not, as layerswap does. */
export function bridgeCalldata(o: { receiver: string; toChainId: number; fromAmount: bigint; token?: string; minOut?: bigint }): string {
  const bridge = { transactionId: ID, bridge: "test", integrator: "strats", referrer: ZERO, sendingAssetId: ZERO, receiver: o.receiver as Hex, minAmount: o.fromAmount, destinationChainId: BigInt(o.toChainId), hasSourceSwaps: false, hasDestinationCall: false };
  const body = o.token !== undefined && o.minOut !== undefined
    ? encodeAbiParameters([BRIDGE_DATA, { type: "address" }, { type: "uint256" }], [bridge, o.token as Hex, o.minOut])
    : encodeAbiParameters([BRIDGE_DATA], [bridge]);
  return `0x4c279d6b${body.slice(2)}`;
}

/** A same-chain swap: (transactionId, integrator, referrer, receiver, minAmountOut). */
export function swapCalldata(o: { receiver: string; minOut: bigint }): string {
  const body = encodeAbiParameters([{ type: "bytes32" }, { type: "string" }, { type: "string" }, { type: "address" }, { type: "uint256" }], [ID, "strats", "", o.receiver as Hex, o.minOut]);
  return `0x5fd9ae2e${body.slice(2)}`;
}
