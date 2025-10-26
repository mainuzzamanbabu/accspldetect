// src/watchers/watch-raydium-grpc.ts
import * as Yellowstone from "@triton-one/yellowstone-grpc";
import bs58 from "bs58";

enum CommitmentLevel {
  CONFIRMED = "confirmed",
}

import { ENV } from "../common/env.js";
import { jsonlWriter } from "../common/logger.js";

/**
 * --- ENV expectations ---
 * GRPC_ENDPOINT: "solana-yellowstone-grpc.publicnode.com:443"   // NO http(s)://
 * GRPC_TOKEN: "<optional token>"                                // depends on provider
 * RAYDIUM_POOLS: '["poolPubkey1","poolPubkey2"]'  OR  "pool1,pool2"
 */

// ----------------------------- ENV & Config ------------------------------

const RAW_ENDPOINT =
  (ENV as any).GRPC_ENDPOINT || "solana-yellowstone-grpc.publicnode.com:443";
const GRPC_TOKEN = (ENV as any).GRPC_TOKEN || undefined;

// Accept array or comma/space-separated string
const rawPools = (ENV as any).RAYDIUM_POOLS;
const POOLS: string[] = Array.isArray(rawPools)
  ? rawPools
  : typeof rawPools === "string"
  ? rawPools.split(/[,\s]+/).filter(Boolean)
  : [];

function validateEnv() {
  const placeholderEndpoint =
    String(RAW_ENDPOINT).includes("your-endpoint") || !RAW_ENDPOINT;
  if (placeholderEndpoint) {
    console.error(
      "[raydium-grpc] ERROR: GRPC endpoint not configured or using placeholder."
    );
    console.error("Set the following environment variable before running:");
    console.error(
      "  GRPC_ENDPOINT - e.g. 'solana-yellowstone-grpc.publicnode.com:443' (hostname:port, NO https://)"
    );
    console.error("Example (PowerShell):");
    console.error(
      "  $env:GRPC_ENDPOINT='solana-yellowstone-grpc.publicnode.com:443' ; npx tsx src/watchers/watch-raydium-grpc.ts"
    );
    process.exit(1);
  }

  if (
    String(RAW_ENDPOINT).includes("http://") ||
    String(RAW_ENDPOINT).includes("https://")
  ) {
    console.warn(
      "[raydium-grpc] WARNING: Endpoint should not include http:// or https:// prefix"
    );
    console.warn(
      "  Use format: hostname:port (e.g., 'solana-yellowstone-grpc.publicnode.com:443')"
    );
  }

  if (POOLS.length === 0) {
    console.error(
      "[raydium-grpc] ERROR: No pools specified in ENV.RAYDIUM_POOLS"
    );
    console.error(
      "Provide a JSON array or comma-separated list of Raydium pool addresses."
    );
    process.exit(1);
  }
}

validateEnv();

const filename = "raydium-grpc.jsonl";
const writer = jsonlWriter(filename);
const seen = new Set<string>();

console.log("[raydium-grpc] Starting Yellowstone gRPC client");
console.log(`[raydium-grpc] Endpoint (raw): ${RAW_ENDPOINT}`);
console.log(
  `[raydium-grpc] Monitoring ${POOLS.length} pool(s): ${POOLS.join(", ")}`
);
console.log(`[raydium-grpc] Writing logs → ${writer.path}\n`);

// --------------------------- Target Builder ------------------------------

function buildGrpcTarget(endpoint: string) {
  // strip protocol + whitespace
  const noProto = endpoint.trim().replace(/^https?:\/\//i, "");
  const [host, port = "443"] = noProto.split(":");
  if (!host) throw new Error(`Invalid GRPC_ENDPOINT: "${endpoint}"`);
  // Canonical gRPC DNS target (note the triple slash)
  const target = `dns:///${host}:${port}`;
  return { target, host, port };
}

// --------------------------- Client Creation -----------------------------

function getClientConstructor() {
  // Try known export shapes from the package
  const candidates = [
    (Yellowstone as any)?.default?.default,
    (Yellowstone as any)?.default,
    Yellowstone as any,
  ].filter(Boolean);

  for (const C of candidates) {
    if (typeof C === "function") return C;
  }
  throw new Error("Could not find Yellowstone client constructor");
}

function createClient(endpoint: string, token?: string) {
  const { target, host } = buildGrpcTarget(endpoint);
  const safeToken = token ?? "";

  // gRPC channel options
  const baseOpts: Record<string, any> = {
    "grpc.max_receive_message_length": 64 * 1024 * 1024,
    "grpc.keepalive_time_ms": 10000,
    "grpc.keepalive_timeout_ms": 5000,

    // Critical for Windows / SNI behind some CDNs
    "grpc.default_authority": host,
    // Uncomment the next line only if your provider/SNI requires it
    // "grpc.ssl_target_name_override": host,
  };

  console.log(`[raydium-grpc] Using target: ${target}`);
  console.log(
    `[raydium-grpc] Token: ${safeToken ? "***" + safeToken.slice(-4) : "none"}`
  );

  const ClientConstructor = getClientConstructor();

  // Try a few instantiation patterns (providers differ)
  const attempts = [
    {
      desc: "standard (target, token, opts)",
      fn: () => new ClientConstructor(target, safeToken, baseOpts),
    },
    {
      desc: "x-token in opts",
      fn: () => {
        const opts = { ...baseOpts, "x-token": safeToken };
        return new ClientConstructor(target, undefined, opts);
      },
    },
    {
      desc: "no token parameter",
      fn: () => new ClientConstructor(target, baseOpts),
    },
    {
      desc: "endpoint in opts object",
      fn: () => {
        const opts = { ...baseOpts, endpoint: target, token: safeToken };
        return new ClientConstructor(opts);
      },
    },
  ];

  for (const attempt of attempts) {
    try {
      const client = attempt.fn();
      if (typeof (client as any)?.subscribe === "function") {
        console.log(
          `[raydium-grpc] ✓ Client created via pattern: ${attempt.desc}`
        );
        return client;
      }
    } catch (e: any) {
      console.log(
        `[raydium-grpc] ✗ Pattern failed: ${attempt.desc} - ${e?.message || e}`
      );
    }
  }

  throw new Error(
    "Could not instantiate Yellowstone client with any known pattern."
  );
}

const client = createClient(RAW_ENDPOINT, GRPC_TOKEN);

// --------------------------- Helpers -------------------------------------

const MAX_RECONNECT_ATTEMPTS = 10;
const PING_INTERVAL_MS = 30_000;

function bufferToBase58(buffer: any): string {
  if (!buffer) return "";
  try {
    if (buffer instanceof Uint8Array) return bs58.encode(buffer as Uint8Array);
    if (buffer && buffer.type === "Buffer" && Array.isArray(buffer.data)) {
      return bs58.encode(Buffer.from(buffer.data));
    }
    if (Buffer.isBuffer(buffer)) return bs58.encode(buffer);
  } catch {
    // ignore
  }
  return "";
}

// --------------------------- Streaming Logic -----------------------------

let reconnectAttempts = 0;
let reconnecting = false;
let currentStream: any | null = null;
let pingIntervalId: NodeJS.Timeout | null = null;

interface SubscribeRequest {
  accounts: { [key: string]: any };
  slots: { [key: string]: any };
  transactions: { [key: string]: any };
  transactionsStatus: { [key: string]: any };
  blocks: { [key: string]: any };
  blocksMeta: { [key: string]: any };
  entry: { [key: string]: any };
  accountsDataSlice: any[];
  ping?: any;
  commitment?: CommitmentLevel;
}

function startPings(stream: any) {
  stopPings();
  pingIntervalId = setInterval(() => {
    try {
      stream.write({ ping: { id: Date.now() } } as any);
    } catch {
      stopPings();
    }
  }, PING_INTERVAL_MS);
}
function stopPings() {
  if (pingIntervalId) {
    clearInterval(pingIntervalId);
    pingIntervalId = null;
  }
}

async function startStreaming() {
  try {
    console.log("[raydium-grpc] Creating subscription stream...");
    const stream = await client.subscribe();
    currentStream = stream;

    const subscribeRequest: SubscribeRequest = {
      slots: { slots: {} },
      accounts: {},
      transactions: {
        raydium_pools: {
          vote: false,
          failed: false,
          accountInclude: POOLS,
          accountExclude: [],
          accountRequired: [],
        },
      },
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      ping: { id: 1 },
      commitment: CommitmentLevel.CONFIRMED,
    };

    console.log("[raydium-grpc] ✓ Sending subscription request...");
    await stream.write(subscribeRequest as any);
    console.log(
      "[raydium-grpc] ✓ Subscription active! Listening for transactions...\n"
    );

    reconnectAttempts = 0;
    startPings(stream);

    stream.on("data", (data: any) => {
      try {
        if (data?.pong) {
          // Keepalive responses
          // console.log(`[raydium-grpc] Received pong: ${data.pong.id}`);
          return;
        }

        if (data?.transaction) {
          const txEnvelope = data.transaction;
          const tx = txEnvelope.transaction;
          const meta = tx?.meta;
          if (!tx || !meta) return;

          const sigBase58 = bufferToBase58(tx.signature);
          if (!sigBase58 || seen.has(sigBase58)) return;
          seen.add(sigBase58);

          const detectedMs = Date.now();
          const blockTime = tx.blockTime || Math.floor(detectedMs / 1000);
          const blockTimeMs = blockTime * 1000;
          const latencyMs = Math.max(0, detectedMs - blockTimeMs);
          const slot = txEnvelope.slot || 0;

          // Infer swap deltas from pre/post token balances
          let swapData: any = {};
          try {
            const preBalances = meta.preTokenBalances || [];
            const postBalances = meta.postTokenBalances || [];
            const changes: any[] = [];

            for (const post of postBalances) {
              const pre = preBalances.find(
                (p: any) => p.accountIndex === post.accountIndex
              );
              if (pre && post.mint === pre.mint) {
                const preAmount = BigInt(pre.uiTokenAmount.amount);
                const postAmount = BigInt(post.uiTokenAmount.amount);
                const change = postAmount - preAmount;
                if (change !== 0n) {
                  const decimals = post.uiTokenAmount.decimals;
                  const uiAmount = Number(change) / Math.pow(10, decimals);
                  changes.push({
                    mint: post.mint,
                    change: change.toString(),
                    decimals,
                    uiAmount,
                  });
                }
              }
            }

            const input = changes.find((c) => BigInt(c.change) < 0n);
            const output = changes.find((c) => BigInt(c.change) > 0n);

            swapData = {
              amountIn: input
                ? Math.abs(input.uiAmount).toFixed(input.decimals)
                : undefined,
              amountOut: output
                ? output.uiAmount.toFixed(output.decimals)
                : undefined,
              tokenIn: input?.mint,
              tokenOut: output?.mint,
            };
          } catch {
            // ignore parsing errors
          }

          // Try to capture the top-level instruction label from logs
          let instruction: string | null = null;
          if (meta.logMessages) {
            const logLine = meta.logMessages.find((l: string) =>
              l.includes("Instruction:")
            );
            if (logLine) {
              const idx = logLine.lastIndexOf("Instruction:");
              instruction =
                idx >= 0
                  ? logLine.slice(idx + "Instruction:".length).trim()
                  : null;
            }
          }

          // Try to tag which configured pool appeared in account keys
          const accountKeys = tx.message?.accountKeys || [];
          let poolAddress: string | null = null;

          for (const pool of POOLS) {
            for (const key of accountKeys) {
              const keyBase58 = bufferToBase58(key);
              if (keyBase58 === pool) {
                poolAddress = pool;
                break;
              }
            }
            if (poolAddress) break;
          }
          if (!poolAddress) poolAddress = POOLS[0]; // fallback tag

          const logEntry = {
            protocol: "raydium",
            signature: sigBase58.slice(0, 16) + "...",
            signature_full: sigBase58,
            solscan: `https://solscan.io/tx/${sigBase58}`,
            slot,
            pool: poolAddress,
            instruction,
            swap_in_amount: swapData.amountIn,
            swap_out_amount: swapData.amountOut,
            token_in: swapData.tokenIn,
            token_out: swapData.tokenOut,
            tx_block_time_ms: blockTimeMs,
            detected_ms: detectedMs,
            latency_ms: latencyMs,
            timestamp: new Date(blockTimeMs).toISOString(),
            err: meta.err ? JSON.stringify(meta.err) : null,
          };

          writer.write(logEntry);

          console.log(
            `[raydium-grpc] ${instruction || "TX"} | ` +
              `${
                swapData.amountIn
                  ? `${swapData.amountIn} → ${swapData.amountOut}`
                  : "N/A"
              } | ` +
              `Pool: ${poolAddress?.slice(0, 8)}... | ` +
              `Latency: ${latencyMs}ms | ` +
              `Sig: ${sigBase58.slice(0, 8)}...`
          );
        }

        // Optional slot logging:
        // if (data?.slot) console.log(`[raydium-grpc] Slot: ${data.slot.slot}`);
      } catch (e: any) {
        console.error("[raydium-grpc] Error processing data:", e?.message || e);
      }
    });

    const onStreamError = (where: string) => (error?: Error) => {
      console.error(
        `[raydium-grpc] Stream ${where}:`,
        error?.message || "(no message)"
      );
      stopPings();
      attemptReconnect();
    };

    stream.on("error", onStreamError("error"));
    stream.on("end", onStreamError("ended"));
    stream.on("close", onStreamError("closed"));

    return stream;
  } catch (error: any) {
    console.error(
      "[raydium-grpc] Failed to start stream:",
      error?.message || error
    );
    attemptReconnect();
  }
}

function attemptReconnect() {
  if (reconnecting) return; // guard against overlapping timers
  reconnecting = true;

  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error(
      "[raydium-grpc] Max reconnection attempts reached. Exiting..."
    );
    process.exit(1);
  }

  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  console.log(
    `[raydium-grpc] Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`
  );

  setTimeout(async () => {
    try {
      console.log("[raydium-grpc] Attempting to reconnect...");
      await startStreaming();
    } finally {
      reconnecting = false;
    }
  }, delay);
}

// Kick it off
startStreaming();

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[raydium-grpc] Shutting down gracefully...");
  try {
    stopPings();
    (currentStream as any)?.end?.();
  } catch {}
  writer.close?.();
  process.exit(0);
});
