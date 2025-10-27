// src/watchers/watch-raydium-grpc.ts
import bs58 from "bs58";
import { createRequire } from "module";

enum CommitmentLevel {
  PROCESSED = "processed",
  CONFIRMED = "confirmed",
}

import { ENV } from "../common/env.js";
import { jsonlWriter } from "../common/logger.js";

/**
 * ENV:
 *   GRPC_ENDPOINT: solana-yellowstone-grpc.publicnode.com:443     (NO http/https)
 *   GRPC_TOKEN:    <optional>
 *   RAYDIUM_POOLS: '["poolPubkey1","poolPubkey2"]'  OR  "pool1,pool2"
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

// Enable debug/troubleshooting mode by setting ENV.RAYDIUM_DEBUG = true
const DEBUG = Boolean((ENV as any).RAYDIUM_DEBUG || process.env.RAYDIUM_DEBUG);

function validateEnv() {
  const placeholderEndpoint =
    String(RAW_ENDPOINT).includes("your-endpoint") || !RAW_ENDPOINT;
  if (placeholderEndpoint) {
    console.error(
      "[raydium-grpc] ERROR: GRPC endpoint not configured or using placeholder."
    );
    console.error(
      "Set GRPC_ENDPOINT to e.g. solana-yellowstone-grpc.publicnode.com:443"
    );
    process.exit(1);
  }

  if (
    String(RAW_ENDPOINT).includes("http://") ||
    String(RAW_ENDPOINT).includes("https://")
  ) {
    console.warn(
      "[raydium-grpc] WARNING: Endpoint should not include http(s):// prefix"
    );
    console.warn(
      "Use hostname:port, e.g. 'solana-yellowstone-grpc.publicnode.com:443'"
    );
  }

  if (POOLS.length === 0) {
    console.error(
      "[raydium-grpc] ERROR: No pools specified in ENV.RAYDIUM_POOLS"
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

// --------------------------- Endpoint Normalizer -------------------------

function normalizeEndpoint(ep: string) {
  const raw = String(ep || "").trim();
  // If caller provided an explicit http(s):// URL, keep it as-is.
  if (/^https?:\/\//i.test(raw)) return raw;

  // If caller provided a dns:/// style address, convert it to an
  // https:// URL so the Yellowstone client (which uses `new URL(...)`)
  // parses the hostname/port correctly and creates TLS credentials.
  if (raw.startsWith("dns:///")) {
    const host = raw.replace(/^dns:\/\//, "").replace(/^\/+/, "");
    return `https://${host}`;
  }

  // No scheme provided: default to HTTPS (most public endpoints use TLS).
  return `https://${raw}`;
}

// --------------------------- Client Loader -------------------------------

type YellowstoneCtor = new (
  endpoint: string,
  token?: string,
  opts?: Record<string, any>
) => any;

async function loadYellowstoneCtor(): Promise<YellowstoneCtor> {
  // Try ESM default import first (official examples)
  try {
    const esm = await import("@triton-one/yellowstone-grpc");
    const C = (esm as any)?.default || (esm as any)?.Client || (esm as any);
    if (typeof C === "function") return C as YellowstoneCtor;
  } catch {}
  // Fallback to CJS via createRequire
  try {
    const req = createRequire(import.meta.url);
    const cjs = req("@triton-one/yellowstone-grpc");
    const C = cjs?.default || cjs?.Client || cjs;
    if (typeof C === "function") return C as YellowstoneCtor;
  } catch {}

  throw new Error("Could not find Yellowstone client constructor");
}

function createClientCtorLogger(
  C: YellowstoneCtor,
  endpoint: string,
  token?: string
) {
  console.log(`[raydium-grpc] Using target: ${endpoint}`);
  console.log(
    `[raydium-grpc] Token: ${token ? "***" + String(token).slice(-4) : "none"}`
  );
  return C;
}

function bufferToBase58(buffer: any): string {
  if (!buffer) return "";
  try {
    if (buffer instanceof Uint8Array) return bs58.encode(buffer as Uint8Array);
    if (buffer && buffer.type === "Buffer" && Array.isArray(buffer.data)) {
      return bs58.encode(Buffer.from(buffer.data));
    }
    if (Buffer.isBuffer(buffer)) return bs58.encode(buffer);
  } catch {}
  return "";
}

// --------------------------- Streaming Logic -----------------------------

const MAX_RECONNECT_ATTEMPTS = 10;
const PING_INTERVAL_MS = 30_000;

let reconnectAttempts = 0;
let reconnecting = false;
let currentStream: any | null = null;
let pingIntervalId: NodeJS.Timeout | null = null;

interface SubscribeRequest {
  accounts?: { [k: string]: any };
  slots?: { [k: string]: any };
  transactions?: { [k: string]: any };
  transactionsStatus?: { [k: string]: any };
  blocks?: { [k: string]: any };
  blocksMeta?: { [k: string]: any };
  entry?: { [k: string]: any };
  accountsDataSlice?: any[];
  ping?: any;
  commitment?: CommitmentLevel;
}

function startPings(stream: any) {
  stopPings();
  pingIntervalId = setInterval(async () => {
    try {
      // Use seconds since epoch (int32-safe) for ping id. Sending
      // millisecond timestamps (Date.now()) can exceed int32 and cause
      // protobuf serialization failures.
      const pingId = Math.floor(Date.now() / 1000);
      if (DEBUG) {
        try {
          const mod = await import("@triton-one/yellowstone-grpc");
          const Ping = (mod as any)?.SubscribeRequestPing;
          if (Ping && typeof Ping.encode === "function") {
            const buf = Ping.encode({ id: pingId }).finish();
            console.log(
              "[raydium-grpc] DEBUG: ping encodes OK (bytes):",
              buf.length
            );
          }
        } catch (e: any) {
          console.error(
            "[raydium-grpc] DEBUG: ping encoding failed:",
            e?.message || e
          );
        }
      }
      stream.write({ ping: { id: pingId } } as any);
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
    const endpoint = normalizeEndpoint(RAW_ENDPOINT);
    const Yellowstone = await loadYellowstoneCtor();
    const Client = createClientCtorLogger(Yellowstone, endpoint, GRPC_TOKEN);

    // Keep opts minimal; avoid authority overrides.
    const opts: Record<string, any> = {
      "grpc.max_receive_message_length": 64 * 1024 * 1024,
      "grpc.keepalive_time_ms": 10000,
      "grpc.keepalive_timeout_ms": 5000,
    };

    const client = new Client(endpoint, GRPC_TOKEN ?? "", opts);

    console.log("[raydium-grpc] Creating subscription stream...");
    const stream = await (client as any).subscribe();
    currentStream = stream;

    // Wrap the stream.write method in DEBUG mode to log outgoing payloads
    // so we can see which message triggers the server-side serialization error.
    if (DEBUG) {
      try {
        const origWrite = (stream as any).write.bind(stream);
        (stream as any).write = function (obj: any, cb?: any) {
          try {
            console.log(
              "[raydium-grpc] DEBUG WRITING:",
              JSON.stringify(obj).slice(0, 1500)
            );
          } catch {}
          return origWrite(obj, cb);
        };
      } catch {}
    }

    // Build a full SubscribeRequest. The protobuf encoder expects map fields
    // like `accounts`, `slots`, `transactionsStatus`, etc. to be objects
    // (not undefined). If those keys are missing the encoder will attempt
    // to call Object.entries(undefined) and throw a serialization error
    // like "Cannot convert undefined or null to object". Provide empty
    // objects/arrays for the unused fields to avoid that.
    // If DEBUG is enabled, broaden the transactions filter so we can see
    // any incoming updates for troubleshooting.
    const subscribeRequest: SubscribeRequest = DEBUG
      ? {
          accounts: {},
          slots: {},
          // Broad transactions filter (no accountInclude) to receive many updates
          transactions: {
            all: {
              vote: false,
              failed: false,
            },
          },
          transactionsStatus: {},
          blocks: {},
          blocksMeta: {},
          entry: {},
          accountsDataSlice: [],
          commitment: 0 as any, // PROCESSED
          ping: { id: 1 },
        }
      : {
          accounts: {},
          slots: {},
          transactions: {
            // Any map key works; this is just a label
            raydium: {
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
          commitment: 0 as any, // PROCESSED
          ping: { id: 1 },
        };

    if (DEBUG) {
      console.log(
        "[raydium-grpc] DEBUG mode enabled — using broad subscription filter"
      );
      try {
        console.log(
          "[raydium-grpc] DEBUG subscribeRequest:",
          JSON.stringify(subscribeRequest, null, 2)
        );
      } catch {}
    }

    console.log("[raydium-grpc] ✓ Sending subscription request...");
    if (DEBUG) {
      try {
        const mod = await import("@triton-one/yellowstone-grpc");
        const SubscribeReq = (mod as any)?.SubscribeRequest;
        if (SubscribeReq && typeof SubscribeReq.encode === "function") {
          const encoded = SubscribeReq.encode(subscribeRequest).finish();
          console.log(
            "[raydium-grpc] DEBUG: subscribeRequest encodes OK (bytes):",
            encoded.length
          );
        }
      } catch (e: any) {
        console.error(
          "[raydium-grpc] DEBUG: subscribeRequest encoding failed:",
          e?.message || e
        );
      }
    }
    await stream.write(subscribeRequest as any);
    console.log(
      "[raydium-grpc] ✓ Subscription active! Listening for transactions...\n"
    );

    reconnectAttempts = 0;
    startPings(stream);

    stream.on("data", (data: any) => {
      if (DEBUG) {
        try {
          // Log a truncated raw update when debugging so we can see what's coming.
          console.log(
            "[raydium-grpc] RAW UPDATE:",
            JSON.stringify(data).slice(0, 2000)
          );
        } catch {}
      }
      try {
        if (data?.pong) return;

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
          } catch {}

          // Instruction label from logs (best effort)
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

          // Tag which configured pool appeared in account keys
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
    // Avoid double reconnect races: don't also handle "end"
    stream.on("close", onStreamError("closed"));
    // Additional stream lifecycle hooks (helpful when debugging connectivity)
    try {
      stream.on("end", () => {
        console.log("[raydium-grpc] Stream ended");
        stopPings();
      });
    } catch {}
    try {
      stream.on("metadata", (m: any) =>
        console.log("[raydium-grpc] Metadata:", m)
      );
    } catch {}
    try {
      stream.on("status", (s: any) => console.log("[raydium-grpc] Status:", s));
    } catch {}
  } catch (error: any) {
    console.error(
      "[raydium-grpc] Failed to start stream:",
      error?.message || error
    );
    attemptReconnect();
  }
}

function attemptReconnect() {
  if (reconnecting) return;
  reconnecting = true;

  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error(
      "[raydium-grpc] Max reconnection attempts reached. Exiting..."
    );
    try {
      writer.close?.();
    } finally {
      process.exit(1);
    }
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
