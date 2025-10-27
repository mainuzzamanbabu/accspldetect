import {
  Commitment,
  Connection,
  PublicKey,
  VersionedTransactionResponse,
} from "@solana/web3.js";
import { ENV, requireRpc } from "../common/env.js";
import { jsonlWriter } from "../common/logger.js";
import {
  fetchTx,
  getBlockTimeMsFallback,
  guessInstructionLabel,
} from "../common/tx-helpers.js";

requireRpc();

const PROGRAM_IDS = [
  new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"), // Raydium CLMM
  new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"), // Raydium CPMM (DAMM-like)
  new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"), // Raydium AMM v4
  new PublicKey("5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h"), // Raydium StableSwap
];

const POOLS = ENV.RAYDIUM_POOLS || [];
const filename = "raydium.jsonl";
const writer = jsonlWriter(filename);
const seen = new Set<string>();
const commitment: Commitment = ENV.COMMITMENT;

// // Use Solana's official RPC - most reliable for free tier
// const HTTP_ENDPOINT = "https://api.mainnet-beta.solana.com";
// const WSS_ENDPOINT = "wss://api.mainnet-beta.solana.com";
const HTTP_ENDPOINT =
  "https://mainnet.helius-rpc.com/?api-key=006ee7a6-cff4-4a4c-8e38-2e153bf2e69d";
const WSS_ENDPOINT =
  "wss://mainnet.helius-rpc.com/?api-key=006ee7a6-cff4-4a4c-8e38-2e153bf2e69d";

// const HTTP_ENDPOINT = "https://solana-rpc.publicnode.com";
// const WSS_ENDPOINT = "wss://solana-rpc.publicnode.com";
// For better performance, consider premium RPC:
// Helius: https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
// QuickNode: Your custom endpoint from quicknode.com
// Triton: https://solana-mainnet.rpc.extrnode.com/YOUR_KEY

const wsConn = new Connection(HTTP_ENDPOINT, {
  commitment,
  wsEndpoint: WSS_ENDPOINT,
});

console.log(`Using HTTP RPC URL: ${HTTP_ENDPOINT}`);
console.log(`Using WSS RPC URL: ${WSS_ENDPOINT}`);

const httpConn = new Connection(ENV.HTTP_RPC_URL || ENV.RPC_URL, {
  commitment,
});

console.log(
  `[raydium] watching ${POOLS.length} specific pool(s), commitment=${commitment}`
);
console.log(`[raydium] pools: ${POOLS.join(", ")}`);
console.log(`[raydium] writing logs → ${writer.path}`);

if (POOLS.length === 0) {
  console.error("[raydium] ERROR: No pools specified in ENV.RAYDIUM_POOLS");
  console.error("[raydium] Please add pool addresses to your .env file");
  process.exit(1);
}

// WebSocket connection management
let isConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

wsConn._rpcWebSocket.on("error", (err: Error) => {
  console.error("[raydium] WebSocket error:", err.message);
  if (err.message.includes("504") || err.message.includes("timeout")) {
    console.log("[raydium] Gateway timeout detected, will reconnect...");
    attemptReconnect();
  }
});

wsConn._rpcWebSocket.on("open", () => {
  console.log("[raydium] WebSocket connection established");
  isConnected = true;
  reconnectAttempts = 0;
});

wsConn._rpcWebSocket.on("close", () => {
  console.log("[raydium] WebSocket connection closed");
  isConnected = false;
  attemptReconnect();
});

function attemptReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error(
      "[raydium] Max reconnection attempts reached. Please restart the script."
    );
    return;
  }

  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  console.log(
    `[raydium] Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`
  );

  setTimeout(() => {
    console.log("[raydium] Attempting to reconnect...");
    setupSubscriptions();
  }, delay);
}

// Track signature processing
const processingSignatures = new Map<string, number>();

setInterval(() => {
  const now = Date.now();
  const fiveMinutes = 5 * 60 * 1000;
  for (const [sig, timestamp] of processingSignatures.entries()) {
    if (now - timestamp > fiveMinutes) {
      processingSignatures.delete(sig);
    }
  }
}, 5 * 60 * 1000);

// Parse swap amounts from transaction
function parseSwapAmounts(tx: VersionedTransactionResponse): {
  amountIn?: string;
  amountOut?: string;
  tokenIn?: string;
  tokenOut?: string;
} {
  try {
    const preBalances = tx.meta?.preTokenBalances || [];
    const postBalances = tx.meta?.postTokenBalances || [];

    const changes: any[] = [];

    // Calculate token balance changes
    for (const post of postBalances) {
      const pre = preBalances.find((p) => p.accountIndex === post.accountIndex);
      if (pre && post.mint === pre.mint) {
        const preAmount = BigInt(pre.uiTokenAmount.amount);
        const postAmount = BigInt(post.uiTokenAmount.amount);
        const change = postAmount - preAmount;

        if (change !== 0n) {
          changes.push({
            mint: post.mint,
            change: change.toString(),
            decimals: post.uiTokenAmount.decimals,
            uiAmount:
              Number(change) / Math.pow(10, post.uiTokenAmount.decimals),
          });
        }
      }
    }

    // Identify input (negative) and output (positive)
    const input = changes.find((c) => BigInt(c.change) < 0n);
    const output = changes.find((c) => BigInt(c.change) > 0n);

    return {
      amountIn: input
        ? Math.abs(input.uiAmount).toFixed(input.decimals)
        : undefined,
      amountOut: output ? output.uiAmount.toFixed(output.decimals) : undefined,
      tokenIn: input?.mint,
      tokenOut: output?.mint,
    };
  } catch (e) {
    return {};
  }
}

// Process transaction signature
async function processSignature(
  signature: string,
  slot: number,
  poolAddress: string
) {
  const detectedMs = Date.now();

  if (seen.has(signature) || processingSignatures.has(signature)) {
    return;
  }

  seen.add(signature);
  processingSignatures.set(signature, detectedMs);

  try {
    // Fetch transaction with retry
    let tx = await fetchTx(httpConn, signature, commitment);
    if (!tx) {
      await new Promise((r) => setTimeout(r, 150));
      tx = await fetchTx(httpConn, signature, commitment);
    }

    if (!tx) {
      writer.write({
        protocol: "raydium",
        signature,
        signature_full: signature,
        solscan: `https://solscan.io/tx/${signature}`,
        slot,
        pool: poolAddress,
        detected_ms: detectedMs,
        tx_block_time_ms: null,
        latency_ms: null,
        note: "transaction not yet available",
      });
      return;
    }

    // Get block time - use slot timestamp as fallback
    const blockTimeMs =
      tx.blockTime != null
        ? tx.blockTime * 1000
        : await getBlockTimeMsFallback(httpConn, tx.slot);

    // Calculate latency (should always be positive)
    const latencyMs =
      blockTimeMs != null ? Math.max(0, detectedMs - blockTimeMs) : null;

    const ixLabel = guessInstructionLabel(tx.meta?.logMessages);

    // Parse swap amounts
    const swapData = parseSwapAmounts(tx);

    // Get all account keys including address lookup tables
    let allAccounts: string[] = [];
    try {
      const accountKeys = tx.transaction.message.getAccountKeys();
      allAccounts = accountKeys.staticAccountKeys.map((k) => k.toBase58());

      // Add loaded addresses if present
      if (accountKeys.accountKeysFromLookups) {
        allAccounts.push(
          ...accountKeys.accountKeysFromLookups.writable.map((k) =>
            k.toBase58()
          )
        );
        allAccounts.push(
          ...accountKeys.accountKeysFromLookups.readonly.map((k) =>
            k.toBase58()
          )
        );
      }
    } catch (e) {
      // Fallback to basic parsing
      allAccounts = tx.transaction.message.staticAccountKeys.map((k) =>
        k.toBase58()
      );
    }

    // Find which program this transaction used
    let matchedProgram: string | null = null;
    for (const programId of PROGRAM_IDS) {
      if (allAccounts.includes(programId.toBase58())) {
        matchedProgram = programId.toBase58();
        break;
      }
    }

    const logEntry = {
      protocol: "raydium",
      programId: matchedProgram,
      // signature: signature.slice(0, 16) + "...", // Shortened for logs
      signature: signature,
      signature_full: signature,
      solscan: `https://solscan.io/tx/${signature}`,
      slot: tx.slot,
      pool: poolAddress,
      instruction: ixLabel,
      swap_in_amount: swapData.amountIn,
      swap_out_amount: swapData.amountOut,
      token_in: swapData.tokenIn,
      token_out: swapData.tokenOut,
      tx_block_time_ms: blockTimeMs,
      detected_ms: detectedMs,
      latency_ms: latencyMs,
      timestamp: new Date(blockTimeMs || detectedMs).toISOString(),
      err: tx.meta?.err ?? null,
    };

    writer.write(logEntry);

    console.log(
      `[raydium] ${ixLabel || "TX"} | ` +
        `${
          swapData.amountIn
            ? swapData.amountIn + " → " + swapData.amountOut
            : "N/A"
        } | ` +
        `Pool: ${poolAddress.slice(0, 8)}... | ` +
        `Latency: ${latencyMs}ms | ` +
        `Sig: ${signature}`
    );
  } catch (e) {
    const errorMsg = (e as Error).message;

    // Check for gateway timeout
    if (errorMsg.includes("504") || errorMsg.includes("Gateway")) {
      console.error(
        `[raydium] Gateway timeout for ${signature.slice(0, 8)}..., skipping`
      );
      writer.write({
        protocol: "raydium",
        signature: signature.slice(0, 16) + "...",
        signature_full: signature,
        solscan: `https://solscan.io/tx/${signature}`,
        slot,
        pool: poolAddress,
        error: "gateway_timeout",
        detected_ms: detectedMs,
      });
      return;
    }

    writer.write({
      protocol: "raydium",
      signature: signature.slice(0, 16) + "...",
      signature_full: signature,
      solscan: `https://solscan.io/tx/${signature}`,
      slot,
      pool: poolAddress,
      error: errorMsg.slice(0, 200), // Truncate long errors
      detected_ms: detectedMs,
    });
    console.error(
      `[raydium] Error processing ${signature.slice(0, 8)}...:`,
      errorMsg.slice(0, 100)
    );
  }
}

// Setup subscriptions
function setupSubscriptions() {
  for (const poolAddress of POOLS) {
    const poolPubkey = new PublicKey(poolAddress);

    try {
      const subscriptionId = wsConn.onAccountChange(
        poolPubkey,
        async (accountInfo, context) => {
          // Get recent signature immediately when account changes
          try {
            const signatures = await httpConn.getSignaturesForAddress(
              poolPubkey,
              { limit: 1 },
              commitment
            );

            if (signatures.length > 0) {
              const sig = signatures[0].signature;
              const slot = signatures[0].slot;
              await processSignature(sig, slot, poolAddress);
            }
          } catch (error) {
            const errorMsg = (error as Error).message;
            if (!errorMsg.includes("429")) {
              // Don't log rate limit errors
              console.error(
                `[raydium] Error fetching signatures:`,
                errorMsg.slice(0, 100)
              );
            }
          }
        },
        commitment
      );

      console.log(
        `[raydium] ✓ Subscribed to pool ${poolAddress.slice(
          0,
          8
        )}... (ID: ${subscriptionId})`
      );
    } catch (error) {
      console.error(
        `[raydium] ✗ Failed to subscribe to pool ${poolAddress}:`,
        (error as Error).message
      );
    }
  }
}

// Initial setup
setupSubscriptions();

console.log(
  `[raydium] All ${POOLS.length} pool subscriptions set up. Waiting for events...`
);
console.log("[raydium] Press Ctrl+C to stop\n");

// Keep the process alive
process.on("SIGINT", () => {
  console.log("\n[raydium] Shutting down gracefully...");
  writer.close?.();
  process.exit(0);
});

// import { Commitment, Connection, PublicKey } from "@solana/web3.js";
// import { ENV, requireRpc } from "../common/env.js";
// import { jsonlWriter } from "../common/logger.js";
// import {
//   fetchTx,
//   flattenAllAccounts,
//   getBlockTimeMsFallback,
//   guessInstructionLabel,
// } from "../common/tx-helpers.js";

// requireRpc();

// const PROGRAM_IDS = [
//   new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"), // Raydium CLMM
//   new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"), // Raydium CPMM (DAMM-like)
//   new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"), // Raydium AMM v4
//   new PublicKey("5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h"), // Raydium StableSwap
// ];

// const POOLS = ENV.RAYDIUM_POOLS || []; // Array of pool addresses
// const filename = "raydium.jsonl";
// const writer = jsonlWriter(filename);
// const seen = new Set<string>();
// const commitment: Commitment = ENV.COMMITMENT;

// // FREE RPC ENDPOINTS - Try these in order:

// // Option 1: Solana Foundation Public RPC (most reliable free option)
// const HTTP_ENDPOINT = "https://solana-rpc.publicnode.com";
// const WSS_ENDPOINT = "wss://solana-rpc.publicnode.com";

// // Option 2: PublicNode (if option 1 is slow)
// // const HTTP_ENDPOINT = "https://solana-rpc.publicnode.com";
// // const WSS_ENDPOINT = "wss://solana-rpc.publicnode.com";

// // Option 3: If you have a premium RPC (Helius, QuickNode, etc.)
// // const HTTP_ENDPOINT = ENV.HTTP_RPC_URL || ENV.RPC_URL;
// // const WSS_ENDPOINT = ENV.WSS_RPC_URL;

// // Create connection with explicit WebSocket endpoint
// const wsConn = new Connection(HTTP_ENDPOINT, {
//   commitment,
//   wsEndpoint: WSS_ENDPOINT,
// });

// console.log(`Using HTTP RPC URL: ${HTTP_ENDPOINT}`);
// console.log(`Using WSS RPC URL: ${WSS_ENDPOINT}`);

// const httpConn = new Connection(ENV.HTTP_RPC_URL || ENV.RPC_URL, {
//   commitment,
// });

// console.log(
//   `[raydium] watching ${POOLS.length} specific pool(s), commitment=${commitment}`
// );
// console.log(`[raydium] pools: ${POOLS.join(", ")}`);
// console.log(`[raydium] writing logs → ${writer.path}`);

// if (POOLS.length === 0) {
//   console.error("[raydium] ERROR: No pools specified in ENV.RAYDIUM_POOLS");
//   console.error("[raydium] Please add pool addresses to your .env file");
//   process.exit(1);
// }

// // Add connection error handling
// wsConn._rpcWebSocket.on("error", (err: Error) => {
//   console.error("[raydium] WebSocket error:", err.message);
// });

// wsConn._rpcWebSocket.on("open", () => {
//   console.log("[raydium] WebSocket connection established");
// });

// wsConn._rpcWebSocket.on("close", () => {
//   console.log("[raydium] WebSocket connection closed");
// });

// // Track signature processing to avoid duplicates
// const processingSignatures = new Map<string, number>(); // sig -> timestamp

// // Clean up old processing signatures every 5 minutes
// setInterval(() => {
//   const now = Date.now();
//   const fiveMinutes = 5 * 60 * 1000;
//   for (const [sig, timestamp] of processingSignatures.entries()) {
//     if (now - timestamp > fiveMinutes) {
//       processingSignatures.delete(sig);
//     }
//   }
// }, 5 * 60 * 1000);

// // Function to process a transaction signature
// async function processSignature(
//   signature: string,
//   slot: number,
//   poolAddress: string
// ) {
//   const detectedMs = Date.now();

//   // Skip if already processing or processed
//   if (seen.has(signature) || processingSignatures.has(signature)) {
//     return;
//   }

//   seen.add(signature);
//   processingSignatures.set(signature, detectedMs);

//   try {
//     let tx = await fetchTx(httpConn, signature, commitment);
//     if (!tx) {
//       await new Promise((r) => setTimeout(r, 200));
//       tx = await fetchTx(httpConn, signature, commitment);
//     }
//     if (!tx) {
//       writer.write({
//         protocol: "raydium",
//         signature,
//         slot,
//         pool: poolAddress,
//         detected_ms: detectedMs,
//         tx_block_time_ms: null,
//         latency_ms: null,
//         note: "transaction not yet available",
//       });
//       return;
//     }

//     const blockTimeMs =
//       tx.blockTime != null
//         ? tx.blockTime * 1000
//         : await getBlockTimeMsFallback(httpConn, tx.slot);

//     const ixLabel = guessInstructionLabel(tx.meta?.logMessages);

//     // Find which program this transaction used
//     const allAccounts = flattenAllAccounts(tx);
//     let matchedProgram: string | null = null;
//     for (const programId of PROGRAM_IDS) {
//       if (allAccounts.includes(programId.toBase58())) {
//         matchedProgram = programId.toBase58();
//         break;
//       }
//     }

//     writer.write({
//       protocol: "raydium",
//       programId: matchedProgram,
//       signature,
//       slot: tx.slot,
//       pool: poolAddress,
//       instruction: ixLabel,
//       tx_block_time_ms: blockTimeMs,
//       detected_ms: detectedMs,
//       latency_ms: blockTimeMs != null ? detectedMs - blockTimeMs : null,
//       err: tx.meta?.err ?? null,
//     });

//     console.log(
//       `[raydium] Processed tx ${signature.slice(
//         0,
//         8
//       )}... for pool ${poolAddress.slice(0, 8)}... latency: ${
//         blockTimeMs != null ? detectedMs - blockTimeMs : "N/A"
//       }ms`
//     );
//   } catch (e) {
//     writer.write({
//       protocol: "raydium",
//       signature,
//       slot,
//       pool: poolAddress,
//       error: (e as Error).message,
//       detected_ms: detectedMs,
//     });
//     console.error(
//       `[raydium] Error processing ${signature.slice(0, 8)}...:`,
//       (e as Error).message
//     );
//   }
// }

// // Subscribe to account changes for each pool
// let subscriptionCount = 0;

// for (const poolAddress of POOLS) {
//   const poolPubkey = new PublicKey(poolAddress);

//   try {
//     // Subscribe to account changes - this will trigger on any transaction affecting this account
//     const subscriptionId = wsConn.onAccountChange(
//       poolPubkey,
//       async (accountInfo, context) => {
//         subscriptionCount++;

//         if (subscriptionCount <= 3) {
//           console.log(
//             `[raydium] Account change detected for pool ${poolAddress.slice(
//               0,
//               8
//             )}... (slot: ${context.slot})`
//           );
//         }

//         // Get recent signatures for this account to find the transaction that caused the change
//         try {
//           const signatures = await httpConn.getSignaturesForAddress(
//             poolPubkey,
//             { limit: 1 },
//             commitment
//           );

//           if (signatures.length > 0) {
//             const sig = signatures[0].signature;
//             const slot = signatures[0].slot;
//             await processSignature(sig, slot, poolAddress);
//           }
//         } catch (error) {
//           console.error(
//             `[raydium] Error fetching signatures for pool ${poolAddress.slice(
//               0,
//               8
//             )}...:`,
//             (error as Error).message
//           );
//         }
//       },
//       commitment
//     );

//     console.log(
//       `[raydium] Subscribed to pool ${poolAddress} (subscription ID: ${subscriptionId})`
//     );
//   } catch (error) {
//     console.error(
//       `[raydium] Failed to subscribe to pool ${poolAddress}:`,
//       (error as Error).message
//     );
//   }
// }

// console.log(
//   `[raydium] All ${POOLS.length} pool subscriptions set up. Waiting for events...`
// );

// // Keep the process alive
// process.on("SIGINT", () => {
//   console.log("\n[raydium] Shutting down gracefully...");
//   process.exit(0);
// });
