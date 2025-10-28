import {
  Commitment,
  Connection,
  PublicKey,
  VersionedTransactionResponse,
} from "@solana/web3.js";
import { ENV, requireRpc } from "../common/env.js";
import { jsonlWriter } from "../common/logger.js";
import { fetchTx, guessInstructionLabel } from "../common/tx-helpers.js";

requireRpc();

// ============================================================================
// CONFIGURATION
// ============================================================================

const PROGRAM_IDS = [
  new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"), // Raydium CLMM
];

const POOLS = ENV.RAYDIUM_POOLS || [];
const filename = "raydium.jsonl";
const writer = jsonlWriter(filename);
const seen = new Set<string>();

// Use 'confirmed' for Helius WebSocket compatibility
// 'processed' may not be supported on all WebSocket endpoints
const commitment: Commitment = "confirmed";

// ============================================================================
// RPC ENDPOINTS
// ============================================================================

const HTTP_ENDPOINT =
  "https://mainnet.helius-rpc.com/?api-key=006ee7a6-cff4-4a4c-8e38-2e153bf2e69d";

const WSS_ENDPOINT =
  "wss://mainnet.helius-rpc.com/?api-key=006ee7a6-cff4-4a4c-8e38-2e153bf2e69d";

// const HTTP_ENDPOINT = "https://solana-rpc.publicnode.com";
// const WSS_ENDPOINT = "wss://solana-rpc.publicnode.com";
const wsConn = new Connection(HTTP_ENDPOINT, {
  commitment,
  wsEndpoint: WSS_ENDPOINT,
  confirmTransactionInitialTimeout: 60000,
});

const httpConn = new Connection(HTTP_ENDPOINT, {
  commitment: "confirmed",
});

console.log(`Using HTTP RPC URL: ${HTTP_ENDPOINT}`);
console.log(`Using WSS RPC URL: ${WSS_ENDPOINT}`);
console.log(`Using commitment: ${commitment}`);

// ============================================================================
// VALIDATION
// ============================================================================

console.log(`[raydium] Monitoring ${POOLS.length} pool(s)`);
console.log(`[raydium] Pools: ${POOLS.join(", ")}`);
console.log(`[raydium] Writing logs → ${writer.path}`);

if (POOLS.length === 0) {
  console.error("[raydium] ERROR: No pools specified in ENV.RAYDIUM_POOLS");
  process.exit(1);
}

// ============================================================================
// CONNECTION MANAGEMENT
// ============================================================================

let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const activeSubscriptions = new Map<number, string>();

wsConn._rpcWebSocket.on("error", (err: Error) => {
  console.error("[raydium] WebSocket error:", err.message);
});

wsConn._rpcWebSocket.on("open", () => {
  console.log("[raydium] ✅ WebSocket connected");
  reconnectAttempts = 0;
});

wsConn._rpcWebSocket.on("close", () => {
  console.log("[raydium] ❌ WebSocket closed");
  attemptReconnect();
});

function attemptReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error("[raydium] Max reconnection attempts reached");
    return;
  }

  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  console.log(`[raydium] Reconnecting in ${delay}ms...`);

  setTimeout(() => {
    setupSubscriptions();
  }, delay);
}

// ============================================================================
// SIGNATURE TRACKING
// ============================================================================

const processingSignatures = new Map<string, number>();

setInterval(() => {
  const now = Date.now();
  for (const [sig, timestamp] of processingSignatures.entries()) {
    if (now - timestamp > 5 * 60 * 1000) {
      processingSignatures.delete(sig);
    }
  }
}, 5 * 60 * 1000);

// ============================================================================
// UTILITIES
// ============================================================================

function formatDhakaTime(ms: number): string {
  const dhakaMs = ms + 6 * 60 * 60 * 1000;
  const d = new Date(dhakaMs);
  const pad2 = (n: number) => n.toString().padStart(2, "0");
  const pad3 = (n: number) => n.toString().padStart(3, "0");

  return `${pad2(d.getUTCDate())}/${pad2(
    d.getUTCMonth() + 1
  )}/${d.getUTCFullYear()}, ${pad2(d.getUTCHours())}:${pad2(
    d.getUTCMinutes()
  )}:${pad2(d.getUTCSeconds())}.${pad3(d.getUTCMilliseconds())}`;
}

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

// ============================================================================
// TRANSACTION PROCESSING
// ============================================================================

async function processSignature(
  signature: string,
  slot: number,
  poolAddress: string,
  detectedMs: number
) {
  if (seen.has(signature) || processingSignatures.has(signature)) {
    return;
  }

  seen.add(signature);
  processingSignatures.set(signature, detectedMs);

  try {
    let tx = await fetchTx(httpConn, signature, "confirmed");

    if (!tx) {
      await new Promise((r) => setTimeout(r, 100));
      tx = await fetchTx(httpConn, signature, "confirmed");
    }

    if (!tx) {
      writer.write({
        protocol: "raydium",
        signature,
        slot,
        pool: poolAddress,
        detected_ms: detectedMs,
        note: "transaction not available",
      });
      return;
    }

    const blockTimeMs = tx.blockTime != null ? tx.blockTime * 1000 : null;
    const latencyMs =
      blockTimeMs != null ? Math.max(0, detectedMs - blockTimeMs) : null;
    const ixLabel = guessInstructionLabel(tx.meta?.logMessages);
    const swapData = parseSwapAmounts(tx);

    let allAccounts: string[] = [];
    try {
      const accountKeys = tx.transaction.message.getAccountKeys();
      allAccounts = accountKeys.staticAccountKeys.map((k) => k.toBase58());

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
      allAccounts = tx.transaction.message.staticAccountKeys.map((k) =>
        k.toBase58()
      );
    }

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
      signature: signature,
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

    const latencyColor =
      latencyMs === null
        ? ""
        : latencyMs < 500
        ? "\x1b[32m"
        : latencyMs < 1000
        ? "\x1b[33m"
        : "\x1b[31m";
    const resetColor = "\x1b[0m";

    console.log(
      `[raydium] ${ixLabel || "TX"} | ` +
        `${
          swapData.amountIn
            ? swapData.amountIn + " → " + swapData.amountOut
            : "N/A"
        } | ` +
        `Pool: ${poolAddress.slice(0, 8)}... | ` +
        `${latencyColor}Latency: ${latencyMs}ms${resetColor} | ` +
        `Detected: ${formatDhakaTime(detectedMs)} | ` +
        `Sig: ${signature}`
    );
  } catch (e) {
    const errorMsg = (e as Error).message;
    console.error(
      `[raydium] Error processing ${signature.slice(0, 8)}...:`,
      errorMsg.slice(0, 100)
    );
  }
}

// ============================================================================
// SUBSCRIPTION SETUP - DIRECT ACCOUNT MONITORING (MORE RELIABLE)
// ============================================================================

function setupSubscriptions() {
  console.log(
    `[raydium] Setting up subscriptions for ${POOLS.length} pools...`
  );

  for (const poolAddress of POOLS) {
    const poolPubkey = new PublicKey(poolAddress);

    try {
      // Subscribe to account changes (reliable for pool-specific monitoring)
      const subscriptionId = wsConn.onAccountChange(
        poolPubkey,
        async (accountInfo, context) => {
          const detectedMs = Date.now();

          try {
            // Get most recent signature
            const signatures = await httpConn.getSignaturesForAddress(
              poolPubkey,
              { limit: 1 },
              commitment
            );

            if (signatures.length > 0) {
              const sig = signatures[0].signature;
              const slot = signatures[0].slot;

              // Process without blocking
              processSignature(sig, slot, poolAddress, detectedMs).catch(
                (e) => {
                  console.error(`[raydium] Process error:`, e.message);
                }
              );
            }
          } catch (error) {
            const errorMsg = (error as Error).message;
            if (!errorMsg.includes("429")) {
              console.error(`[raydium] Fetch error:`, errorMsg.slice(0, 100));
            }
          }
        },
        commitment
      );

      activeSubscriptions.set(subscriptionId, poolAddress);
      console.log(
        `[raydium] ✓ Subscribed to pool ${poolAddress.slice(
          0,
          8
        )}... (ID: ${subscriptionId})`
      );
    } catch (error) {
      console.error(
        `[raydium] ✗ Failed to subscribe to ${poolAddress}:`,
        (error as Error).message
      );
    }
  }
}

// ============================================================================
// STARTUP
// ============================================================================

setupSubscriptions();

console.log(
  `\n[raydium] ⚡ Monitoring ${POOLS.length} pool(s) with commitment=${commitment}`
);
console.log("[raydium] Press Ctrl+C to stop\n");

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

process.on("SIGINT", () => {
  console.log("\n[raydium] Shutting down...");

  for (const [subId, poolAddr] of activeSubscriptions.entries()) {
    try {
      wsConn.removeAccountChangeListener(subId);
      console.log(`[raydium] Unsubscribed from ${poolAddr.slice(0, 8)}...`);
    } catch (e) {
      // Ignore
    }
  }

  writer.close?.();
  process.exit(0);
});

// import {
//   Commitment,
//   Connection,
//   PublicKey,
//   VersionedTransactionResponse,
// } from "@solana/web3.js";
// import { ENV, requireRpc } from "../common/env.js";
// import { jsonlWriter } from "../common/logger.js";
// import {
//   fetchTx,
//   getBlockTimeMsFallback,
//   guessInstructionLabel,
// } from "../common/tx-helpers.js";

// requireRpc();

// const PROGRAM_IDS = [
//   new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"), // Raydium CLMM
//   // new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"), // Raydium CPMM (DAMM-like)
//   // new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"), // Raydium AMM v4
//   // new PublicKey("5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h"), // Raydium StableSwap
// ];

// const POOLS = ENV.RAYDIUM_POOLS || [];
// const filename = "raydium.jsonl";
// const writer = jsonlWriter(filename);
// const seen = new Set<string>();
// const commitment: Commitment = ENV.COMMITMENT;

// // // Use Solana's official RPC - most reliable for free tier
// // const HTTP_ENDPOINT = "https://api.mainnet-beta.solana.com";
// // const WSS_ENDPOINT = "wss://api.mainnet-beta.solana.com";
// const HTTP_ENDPOINT =
//   "https://mainnet.helius-rpc.com/?api-key=006ee7a6-cff4-4a4c-8e38-2e153bf2e69d";
// const WSS_ENDPOINT =
//   "wss://mainnet.helius-rpc.com/?api-key=006ee7a6-cff4-4a4c-8e38-2e153bf2e69d";

// // const HTTP_ENDPOINT = "https://solana-rpc.publicnode.com";
// // const WSS_ENDPOINT = "wss://solana-rpc.publicnode.com";
// // For better performance, consider premium RPC:
// // Helius: https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
// // QuickNode: Your custom endpoint from quicknode.com
// // Triton: https://solana-mainnet.rpc.extrnode.com/YOUR_KEY

// const wsConn = new Connection(HTTP_ENDPOINT, {
//   commitment,
//   wsEndpoint: WSS_ENDPOINT,
// });

// console.log(`Using HTTP RPC URL: ${HTTP_ENDPOINT}`);
// console.log(`Using WSS RPC URL: ${WSS_ENDPOINT}`);

// const httpConn = new Connection(ENV.HTTP_RPC_URL || ENV.RPC_URL, {
//   commitment,
// });
// async function getBlockTimeMsFallback(
//   conn: Connection,
//   slot: number
// ): Promise<number | null> {
//   try {
//     const block = await conn.getBlock(slot, {
//       maxSupportedTransactionVersion: 0,
//     });

//     if (block?.blockTime != null) {
//       return block.blockTime * 1000; // Convert seconds to milliseconds
//     }

//     // If no blockTime, return null instead of calculating from slot
//     return null;
//   } catch (e) {
//     console.error(`Failed to get block time for slot ${slot}:`, e);
//     return null;
//   }
// }

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

// // WebSocket connection management
// let isConnected = false;
// let reconnectAttempts = 0;
// const MAX_RECONNECT_ATTEMPTS = 5;

// wsConn._rpcWebSocket.on("error", (err: Error) => {
//   console.error("[raydium] WebSocket error:", err.message);
//   if (err.message.includes("504") || err.message.includes("timeout")) {
//     console.log("[raydium] Gateway timeout detected, will reconnect...");
//     attemptReconnect();
//   }
// });

// wsConn._rpcWebSocket.on("open", () => {
//   console.log("[raydium] WebSocket connection established");
//   isConnected = true;
//   reconnectAttempts = 0;
// });

// wsConn._rpcWebSocket.on("close", () => {
//   console.log("[raydium] WebSocket connection closed");
//   isConnected = false;
//   attemptReconnect();
// });

// function attemptReconnect() {
//   if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
//     console.error(
//       "[raydium] Max reconnection attempts reached. Please restart the script."
//     );
//     return;
//   }

//   reconnectAttempts++;
//   const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
//   console.log(
//     `[raydium] Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`
//   );

//   setTimeout(() => {
//     console.log("[raydium] Attempting to reconnect...");
//     setupSubscriptions();
//   }, delay);
// }

// // Track signature processing
// const processingSignatures = new Map<string, number>();

// setInterval(() => {
//   const now = Date.now();
//   const fiveMinutes = 5 * 60 * 1000;
//   for (const [sig, timestamp] of processingSignatures.entries()) {
//     if (now - timestamp > fiveMinutes) {
//       processingSignatures.delete(sig);
//     }
//   }
// }, 5 * 60 * 1000);

// // Parse swap amounts from transaction
// function parseSwapAmounts(tx: VersionedTransactionResponse): {
//   amountIn?: string;
//   amountOut?: string;
//   tokenIn?: string;
//   tokenOut?: string;
// } {
//   try {
//     const preBalances = tx.meta?.preTokenBalances || [];
//     const postBalances = tx.meta?.postTokenBalances || [];

//     const changes: any[] = [];

//     // Calculate token balance changes
//     for (const post of postBalances) {
//       const pre = preBalances.find((p) => p.accountIndex === post.accountIndex);
//       if (pre && post.mint === pre.mint) {
//         const preAmount = BigInt(pre.uiTokenAmount.amount);
//         const postAmount = BigInt(post.uiTokenAmount.amount);
//         const change = postAmount - preAmount;

//         if (change !== 0n) {
//           changes.push({
//             mint: post.mint,
//             change: change.toString(),
//             decimals: post.uiTokenAmount.decimals,
//             uiAmount:
//               Number(change) / Math.pow(10, post.uiTokenAmount.decimals),
//           });
//         }
//       }
//     }

//     // Identify input (negative) and output (positive)
//     const input = changes.find((c) => BigInt(c.change) < 0n);
//     const output = changes.find((c) => BigInt(c.change) > 0n);

//     return {
//       amountIn: input
//         ? Math.abs(input.uiAmount).toFixed(input.decimals)
//         : undefined,
//       amountOut: output ? output.uiAmount.toFixed(output.decimals) : undefined,
//       tokenIn: input?.mint,
//       tokenOut: output?.mint,
//     };
//   } catch (e) {
//     return {};
//   }
// }

// // Process transaction signature
// async function processSignature(
//   signature: string,
//   slot: number,
//   poolAddress: string
// ) {
//   const detectedMs = Date.now();
//   // console.log("Detected time:", detectedMs);
//   if (seen.has(signature) || processingSignatures.has(signature)) {
//     return;
//   }

//   seen.add(signature);
//   processingSignatures.set(signature, detectedMs);

//   try {
//     // Fetch transaction with retry
//     let tx = await fetchTx(httpConn, signature, commitment);
//     if (!tx) {
//       await new Promise((r) => setTimeout(r, 150));
//       tx = await fetchTx(httpConn, signature, commitment);
//     }

//     if (!tx) {
//       writer.write({
//         protocol: "raydium",
//         signature,
//         signature_full: signature,
//         solscan: `https://solscan.io/tx/${signature}`,
//         slot,
//         pool: poolAddress,
//         detected_ms: detectedMs,
//         tx_block_time_ms: null,
//         latency_ms: null,
//         note: "transaction not yet available",
//       });
//       return;
//     }

//     // Get block time - use slot timestamp as fallback
//     // const blockTimeMs =
//     //   tx.blockTime != null
//     //     ? tx.blockTime * 1000
//     //     : await getBlockTimeMsFallback(httpConn, tx.slot);
//     // Get block time with millisecond precision
//     const blockTimeMs =
//       tx.blockTime != null
//         ? tx.blockTime * 1000
//         : await getBlockTimeMsFallback(httpConn, tx.slot);
//     console.log("Block time ms:", blockTimeMs);
//     // Calculate latency (should always be positive)
//     const latencyMs =
//       blockTimeMs != null ? Math.max(0, detectedMs - blockTimeMs) : null;

//     const ixLabel = guessInstructionLabel(tx.meta?.logMessages);

//     // Parse swap amounts
//     const swapData = parseSwapAmounts(tx);

//     // Get all account keys including address lookup tables
//     let allAccounts: string[] = [];
//     try {
//       const accountKeys = tx.transaction.message.getAccountKeys();
//       allAccounts = accountKeys.staticAccountKeys.map((k) => k.toBase58());

//       // Add loaded addresses if present
//       if (accountKeys.accountKeysFromLookups) {
//         allAccounts.push(
//           ...accountKeys.accountKeysFromLookups.writable.map((k) =>
//             k.toBase58()
//           )
//         );
//         allAccounts.push(
//           ...accountKeys.accountKeysFromLookups.readonly.map((k) =>
//             k.toBase58()
//           )
//         );
//       }
//     } catch (e) {
//       // Fallback to basic parsing
//       allAccounts = tx.transaction.message.staticAccountKeys.map((k) =>
//         k.toBase58()
//       );
//     }

//     // Find which program this transaction used
//     let matchedProgram: string | null = null;
//     for (const programId of PROGRAM_IDS) {
//       if (allAccounts.includes(programId.toBase58())) {
//         matchedProgram = programId.toBase58();
//         break;
//       }
//     }

//     const logEntry = {
//       protocol: "raydium",
//       programId: matchedProgram,
//       // signature: signature.slice(0, 16) + "...", // Shortened for logs
//       signature: signature,
//       signature_full: signature,
//       solscan: `https://solscan.io/tx/${signature}`,
//       slot: tx.slot,
//       pool: poolAddress,
//       instruction: ixLabel,
//       swap_in_amount: swapData.amountIn,
//       swap_out_amount: swapData.amountOut,
//       token_in: swapData.tokenIn,
//       token_out: swapData.tokenOut,
//       tx_block_time_ms: blockTimeMs,
//       detected_ms: detectedMs,
//       latency_ms: latencyMs,
//       timestamp: new Date(blockTimeMs || detectedMs).toISOString(),
//       err: tx.meta?.err ?? null,
//     };

//     writer.write(logEntry);

//     // Helper to format a ms timestamp into Dhaka local time (UTC+6) including milliseconds
//     const pad2 = (n: number) => n.toString().padStart(2, "0");
//     const pad3 = (n: number) => n.toString().padStart(3, "0");
//     function formatDhakaWithMs(ms: number) {
//       // Dhaka is UTC+6 with no DST; shift epoch by +6 hours and use UTC getters
//       const dhakaMs = ms + 6 * 60 * 60 * 1000;
//       const d = new Date(dhakaMs);
//       const day = pad2(d.getUTCDate());
//       const month = pad2(d.getUTCMonth() + 1);
//       const year = d.getUTCFullYear();
//       const hour = pad2(d.getUTCHours());
//       const minute = pad2(d.getUTCMinutes());
//       const second = pad2(d.getUTCSeconds());
//       const milli = pad3(d.getUTCMilliseconds());
//       // Format: DD/MM/YYYY, HH:MM:SS.mmm
//       return `${day}/${month}/${year}, ${hour}:${minute}:${second}.${milli}`;
//     }

//     const detectedDhaka = formatDhakaWithMs(detectedMs);
//     const blockTimeDhaka =
//       blockTimeMs != null ? formatDhakaWithMs(blockTimeMs) : null;

//     console.log(
//       `[raydium] ${ixLabel || "TX"} | ` +
//         `${
//           swapData.amountIn
//             ? swapData.amountIn + " → " + swapData.amountOut
//             : "N/A"
//         } | ` +
//         `Pool: ${poolAddress.slice(0, 8)}... | ` +
//         `Latency: ${latencyMs}ms | ` +
//         `Detected: ${detectedMs} (${detectedDhaka}) | ` +
//         `BlockTime: ${
//           blockTimeMs != null
//             ? blockTimeMs + " (" + blockTimeDhaka + ")"
//             : "N/A"
//         } | ` +
//         `Sig: ${signature}`
//     );
//   } catch (e) {
//     const errorMsg = (e as Error).message;

//     // Check for gateway timeout
//     if (errorMsg.includes("504") || errorMsg.includes("Gateway")) {
//       console.error(
//         `[raydium] Gateway timeout for ${signature.slice(0, 8)}..., skipping`
//       );
//       writer.write({
//         protocol: "raydium",
//         signature: signature.slice(0, 16) + "...",
//         signature_full: signature,
//         solscan: `https://solscan.io/tx/${signature}`,
//         slot,
//         pool: poolAddress,
//         error: "gateway_timeout",
//         detected_ms: detectedMs,
//       });
//       return;
//     }

//     writer.write({
//       protocol: "raydium",
//       signature: signature.slice(0, 16) + "...",
//       signature_full: signature,
//       solscan: `https://solscan.io/tx/${signature}`,
//       slot,
//       pool: poolAddress,
//       error: errorMsg.slice(0, 200), // Truncate long errors
//       detected_ms: detectedMs,
//     });
//     console.error(
//       `[raydium] Error processing ${signature.slice(0, 8)}...:`,
//       errorMsg.slice(0, 100)
//     );
//   }
// }

// // Setup subscriptions
// function setupSubscriptions() {
//   for (const poolAddress of POOLS) {
//     const poolPubkey = new PublicKey(poolAddress);

//     try {
//       const subscriptionId = wsConn.onAccountChange(
//         poolPubkey,
//         async (accountInfo, context) => {
//           // Get recent signature immediately when account changes
//           try {
//             const signatures = await httpConn.getSignaturesForAddress(
//               poolPubkey,
//               { limit: 1 },
//               commitment
//             );

//             if (signatures.length > 0) {
//               const sig = signatures[0].signature;
//               const slot = signatures[0].slot;
//               await processSignature(sig, slot, poolAddress);
//             }
//           } catch (error) {
//             const errorMsg = (error as Error).message;
//             if (!errorMsg.includes("429")) {
//               // Don't log rate limit errors
//               console.error(
//                 `[raydium] Error fetching signatures:`,
//                 errorMsg.slice(0, 100)
//               );
//             }
//           }
//         },
//         commitment
//       );

//       console.log(
//         `[raydium] ✓ Subscribed to pool ${poolAddress.slice(
//           0,
//           8
//         )}... (ID: ${subscriptionId})`
//       );
//     } catch (error) {
//       console.error(
//         `[raydium] ✗ Failed to subscribe to pool ${poolAddress}:`,
//         (error as Error).message
//       );
//     }
//   }
// }

// // Initial setup
// setupSubscriptions();

// console.log(
//   `[raydium] All ${POOLS.length} pool subscriptions set up. Waiting for events...`
// );
// console.log("[raydium] Press Ctrl+C to stop\n");

// // Keep the process alive
// process.on("SIGINT", () => {
//   console.log("\n[raydium] Shutting down gracefully...");
//   writer.close?.();
//   process.exit(0);
// });
