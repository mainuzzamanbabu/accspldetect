import { Commitment, Connection, Logs, PublicKey } from "@solana/web3.js";
import { ENV, requireRpc } from "../common/env.js";
import { jsonlWriter } from "../common/logger.js";
import {
  fetchTx,
  flattenAllAccounts,
  getBlockTimeMsFallback,
  guessInstructionLabel,
  poolMentionedInTx,
} from "../common/tx-helpers.js";

requireRpc();

const PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"); // Meteora DAMM v2 (CP-AMM)
const POOLS = new Set(ENV.METEORA_CPAMM_POOLS);

const filename = "meteora-cpamm.jsonl";
const writer = jsonlWriter(filename);
const seen = new Set<string>();
const commitment: Commitment = ENV.COMMITMENT;

const wsConn = new Connection(ENV.RPC_URL, { commitment });
const httpConn = new Connection(ENV.HTTP_RPC_URL || ENV.RPC_URL, {
  commitment,
});

console.log(
  `[meteora:cpamm] watching program ${PROGRAM_ID.toBase58()}, commitment=${commitment}`
);
if (POOLS.size)
  console.log(`[meteora:cpamm] filtering pools: ${[...POOLS].join(", ")}`);
console.log(`[meteora:cpamm] writing logs → ${writer.path}`);

wsConn.onLogs(
  PROGRAM_ID,
  async (ev: Logs, ctx) => {
    const detectedMs = Date.now();
    const sig = (ev as any).signature as string;
    const slot = (ev as any).slot ?? ctx?.slot;
    if (!sig || seen.has(sig)) return;
    seen.add(sig);

    try {
      let tx = await fetchTx(httpConn, sig, commitment);
      if (!tx) {
        await new Promise((r) => setTimeout(r, 150));
        tx = await fetchTx(httpConn, sig, commitment);
      }
      if (!tx) {
        writer.write({
          protocol: "meteora-cpamm",
          signature: sig,
          slot,
          programId: PROGRAM_ID.toBase58(),
          detected_ms: detectedMs,
          tx_block_time_ms: null,
          latency_ms: null,
          note: "transaction not yet available",
        });
        return;
      }

      const allAccounts = flattenAllAccounts(tx);
      const matchedPool = poolMentionedInTx(allAccounts, POOLS);
      if (!matchedPool && POOLS.size > 0) return;

      const blockTimeMs =
        tx.blockTime != null
          ? tx.blockTime * 1000
          : await getBlockTimeMsFallback(httpConn, tx.slot);
      const ixLabel = guessInstructionLabel(tx.meta?.logMessages);

      writer.write({
        protocol: "meteora-cpamm",
        signature: sig,
        slot: tx.slot,
        programId: PROGRAM_ID.toBase58(),
        pool: matchedPool ?? null,
        instruction: ixLabel,
        tx_block_time_ms: blockTimeMs,
        detected_ms: detectedMs,
        latency_ms: blockTimeMs != null ? detectedMs - blockTimeMs : null,
        err: tx.meta?.err ?? null,
      });
    } catch (e) {
      writer.write({
        protocol: "meteora-cpamm",
        signature: sig,
        slot,
        error: (e as Error).message,
        detected_ms: detectedMs,
      });
    }
  },
  commitment
);
