import { Connection, PublicKey, Logs, Commitment } from "@solana/web3.js";
import { ENV, requireRpc } from "../common/env.js";
import { jsonlWriter } from "../common/logger.js";
import {
  fetchTx,
  getBlockTimeMsFallback,
  flattenAllAccounts,
  guessInstructionLabel,
  poolMentionedInTx,
} from "../common/tx-helpers.js";

requireRpc();

const PROGRAM_ID = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"); // Orca Whirlpools (mainnet)
// Use configured pools from ENV or fall back to a small default set
const POOLS = new Set(
  ENV.ORCA_POOLS.length
    ? ENV.ORCA_POOLS
    : ["Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE"]
);

const filename = "orca.jsonl";
const writer = jsonlWriter(filename);
const seen = new Set<string>();
// Track signature processing to avoid duplicates while in-flight: sig -> timestamp
const processingSignatures = new Map<string, number>();

const commitment: Commitment = ENV.COMMITMENT;

// Convert ws -> http if needed
function wsToHttp(u: string | undefined): string | undefined {
  if (!u) return undefined;
  return u.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
}

const defaultHttp =
  ENV.HTTP_RPC_URL ||
  wsToHttp(ENV.RPC_URL) ||
  "https://api.mainnet-beta.solana.com";
console.log("defaultHttp", defaultHttp);

const wsUrl =
  ENV.RPC_URL ||
  defaultHttp.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
console.log("wsUrl", wsUrl);

// WS at processed for fast callbacks; HTTP at your configured commitment
let wsConn = new Connection(defaultHttp, {
  commitment: "processed" as Commitment,
  disableRetryOnRateLimit: false,
  wsEndpoint: wsUrl,
});

const httpConn = new Connection(ENV.HTTP_RPC_URL || defaultHttp, {
  commitment,
});

console.log(
  `[orca] watching program ${PROGRAM_ID.toBase58()} with commitment=${commitment}`
);
if (POOLS.size) console.log(`[orca] filtering pools: ${[...POOLS].join(", ")}`);
console.log(`[orca] writing logs → ${writer.path}`);

// ---------- Connection test (run on HTTP conn so commitment is >= confirmed) ----------
(async () => {
  try {
    const slot = await httpConn.getSlot(); // uses httpConn's 'confirmed' default
    console.log(`[orca] ✓ Connected to Solana. Current slot: ${slot}`);

    const recentSigs = await httpConn.getSignaturesForAddress(PROGRAM_ID, {
      limit: 1,
    });
    if (recentSigs.length > 0) {
      console.log(
        `[orca] ✓ Found recent program activity: ${recentSigs[0].signature.slice(
          0,
          16
        )}...`
      );
    } else {
      console.log(`[orca] ⚠️  No recent activity found for this program`);
    }
  } catch (err) {
    console.error(`[orca] ✗ Connection test failed:`, err);
  }
})();

// Heartbeat
let eventCount = 0;
let lastEventTime = Date.now();
setInterval(() => {
  const secondsSinceLastEvent = Math.floor((Date.now() - lastEventTime) / 1000);
  console.log(
    `[orca] ⏱️  Still monitoring... (${eventCount} events processed, ${seen.size} unique txs, last event ${secondsSinceLastEvent}s ago)`
  );
}, 30000);

// Clean up old processing signatures every 5 minutes
setInterval(() => {
  const now = Date.now();
  const fiveMinutes = 5 * 60 * 1000;
  for (const [sig, timestamp] of processingSignatures.entries()) {
    if (now - timestamp > fiveMinutes) {
      processingSignatures.delete(sig);
    }
  }
}, 5 * 60 * 1000);

// -----------------------------------------------------------------------------
// Robust logsSubscribe with provider fallback
// -----------------------------------------------------------------------------
console.log(`[orca] Attempting to subscribe to program logs...`);

const PROGRAM_STR = PROGRAM_ID.toBase58();
// Prefer subscribing with a program filter (less noisy). Fall back to 'all' only
// if the provider rejects program subscriptions (some public providers mis-handle
// the `mentions` filter).
let usingAllFilter = false;

// Helper: does a log batch mention our program?
function logsMentionProgram(
  lines: string[] | undefined,
  programStr: string
): boolean {
  if (!lines || lines.length === 0) return false;
  return lines.some((l) => typeof l === "string" && l.includes(programStr));
}

// Shared onLogs handler
const onLog = async (ev: Logs, ctx: any) => {
  eventCount++;
  lastEventTime = Date.now();

  const detectedMs = Date.now();
  const sig = (ev as any).signature as string;
  const slot = (ev as any).slot ?? ctx?.slot;
  const lines: string[] | undefined =
    (ev as any).logs ?? (ev as any).value?.logs;

  // Local prefilter if subscribed with 'all'
  if (usingAllFilter && !logsMentionProgram(lines, PROGRAM_STR)) {
    return;
  }

  console.log(
    `[orca] 📥 Event #${eventCount}: ${sig?.slice(0, 16)}... (slot ${slot})`
  );

  if (!sig || seen.has(sig) || processingSignatures.has(sig)) {
    console.log(
      `[orca] ⏭️  Skipping (already seen, processing, or no signature)`
    );
    return;
  }
  seen.add(sig);
  processingSignatures.set(sig, detectedMs);

  try {
    let tx = await fetchTx(httpConn, sig, commitment);
    if (!tx) {
      console.log(`[orca] ⏳ Transaction not available, retrying...`);
      await new Promise((r) => setTimeout(r, 150));
      tx = await fetchTx(httpConn, sig, commitment);
    }
    if (!tx) {
      console.log(
        `[orca] ⚠️  Transaction still not available: ${sig.slice(0, 16)}...`
      );
      writer.write({
        protocol: "orca",
        signature: sig.slice(0, 16) + "...",
        signature_full: sig,
        solscan: `https://solscan.io/tx/${sig}`,
        slot,
        programId: PROGRAM_STR,
        detected_ms: detectedMs,
        tx_block_time_ms: null,
        latency_ms: null,
        note: "transaction not yet available",
      });
      processingSignatures.delete(sig);
      return;
    }

    const allAccounts = flattenAllAccounts(tx);
    const matchedPool = poolMentionedInTx(allAccounts, POOLS);
    if (!matchedPool && POOLS.size > 0) {
      console.log(`[orca] ⏭️  Skipping (pool not in filter list)`);
      return;
    }

    const blockTimeMs =
      tx.blockTime != null
        ? tx.blockTime * 1000
        : await getBlockTimeMsFallback(httpConn, tx.slot);

    const ixLabel = guessInstructionLabel(tx.meta?.logMessages);

    const logEntry = {
      protocol: "orca",
      signature: sig,
      signature_full: sig,
      solscan: `https://solscan.io/tx/${sig}`,
      slot: tx.slot,
      programId: PROGRAM_STR,
      pool: matchedPool ?? null,
      instruction: ixLabel,
      tx_block_time_ms: blockTimeMs,
      detected_ms: detectedMs,
      latency_ms: blockTimeMs != null ? detectedMs - blockTimeMs : null,
      err: tx.meta?.err ?? null,
    };

    writer.write(logEntry);
    processingSignatures.delete(sig);
    console.log(
      `[orca] ✅ Logged: ${ixLabel || "unknown"} on pool ${matchedPool?.slice(
        0,
        8
      )}... (latency: ${logEntry.latency_ms}ms)`
    );
  } catch (e) {
    const errorMsg = (e as Error)?.message ?? String(e);

    // Check for gateway timeout / 504-like errors and record specially
    if (
      typeof errorMsg === "string" &&
      (errorMsg.includes("504") || errorMsg.includes("Gateway"))
    ) {
      console.error(
        `[orca] Gateway timeout for ${sig?.slice(0, 8)}..., skipping`
      );
      writer.write({
        protocol: "orca",
        signature: sig?.slice(0, 16) + "...",
        signature_full: sig,
        solscan: `https://solscan.io/tx/${sig}`,
        slot,
        programId: PROGRAM_STR,
        error: "gateway_timeout",
        detected_ms: detectedMs,
      });
      processingSignatures.delete(sig);
      return;
    }

    console.error(`[orca] ❌ Error processing ${sig?.slice(0, 16)}:`, errorMsg);
    writer.write({
      protocol: "orca",
      signature: sig?.slice(0, 16) + "...",
      signature_full: sig,
      solscan: `https://solscan.io/tx/${sig}`,
      slot,
      programId: PROGRAM_STR,
      error: (errorMsg as string).slice(0, 200),
      detected_ms: detectedMs,
    });
    processingSignatures.delete(sig);
  }
};

// Subscribe with robust fallback
let subscriptionId: number | null = null;
let reconnectTimeout: NodeJS.Timeout | null = null;

function subscribeLogs(): void {
  try {
    // Clean up old subscription
    if (subscriptionId !== null) {
      try {
        wsConn.removeOnLogsListener(subscriptionId);
      } catch (e) {
        // ignore
      }
      subscriptionId = null;
    }

    // Try program filter first (less noise). If it fails, fall back to 'all'.
    try {
      subscriptionId = wsConn.onLogs(PROGRAM_ID, onLog, "processed");
      usingAllFilter = false;
      console.log(
        `[orca] ✓ Subscribed to program logs using filter=program (subscription ID: ${subscriptionId})`
      );
      return;
    } catch (err) {
      console.warn(
        `[orca] Program filter subscription failed, falling back to 'all':`,
        (err as Error)?.message ?? err
      );
      // fall through to try 'all'
    }

    // Fallback to 'all' if program filter not supported by provider
    try {
      subscriptionId = wsConn.onLogs("all", onLog, "processed");
      usingAllFilter = true;
      console.log(
        `[orca] ✓ Subscribed to program logs using filter=all (subscription ID: ${subscriptionId})`
      );
      return;
    } catch (err) {
      console.error(
        `[orca] ✗ logsSubscribe failed for both 'program' and 'all':`,
        err
      );
      scheduleReconnect();
    }
  } catch (err) {
    console.error(`[orca] ✗ logsSubscribe failed at call time:`, err);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimeout) return; // already scheduled

  console.log("[orca] Scheduling reconnection in 5 seconds...");
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    console.log("[orca] Attempting to reconnect...");

    // Create new connection
    wsConn = new Connection(defaultHttp, {
      commitment: "processed" as Commitment,
      disableRetryOnRateLimit: false,
      wsEndpoint: wsUrl,
    });

    attachWebsocketHandlers();
    subscribeLogs();
  }, 5000);
}

// Attach defensive WS handlers
function attachWebsocketHandlers() {
  try {
    const anyWsConn: any = wsConn;
    const rpcWs =
      anyWsConn._rpcWebSocket ?? anyWsConn.rpcWebSocket ?? anyWsConn._rpcClient;

    if (rpcWs && typeof rpcWs.on === "function") {
      // Main error handler
      rpcWs.on("error", (err: any) => {
        const msg = (err?.message ?? String(err)).toLowerCase();
        console.error("[orca] websocket error:", err?.message ?? err);

        // Check if it's a subscription-related error
        if (
          msg.includes("logssubscribe") ||
          msg.includes("response malformed") ||
          msg.includes('include either "result" or "error"') ||
          msg.includes("subscription")
        ) {
          console.warn("[orca] Subscription error detected, reconnecting...");
          scheduleReconnect();
        }
      });

      // Connection close handler
      rpcWs.on("close", () => {
        console.warn("[orca] WebSocket connection closed, reconnecting...");
        scheduleReconnect();
      });

      // Message handler with error catching
      rpcWs.on("message", (data: any) => {
        try {
          // Parse and check for errors in the response
          if (typeof data === "string") {
            try {
              const parsed = JSON.parse(data);
              if (parsed.error && parsed.result) {
                console.error(
                  "[orca] Malformed server response detected:",
                  parsed
                );
                scheduleReconnect();
              }
            } catch (e) {
              // not JSON or parsing failed, ignore
            }
          }
        } catch (e) {
          console.error(
            "[orca] message handler error:",
            (e as Error)?.message ?? e
          );
        }
      });
    }
  } catch (e) {
    console.error(
      "[orca] failed to attach websocket handlers:",
      (e as Error)?.message ?? e
    );
  }
}

// Initial setup
attachWebsocketHandlers();
subscribeLogs();

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[orca] Shutting down gracefully...");
  console.log(
    `[orca] Processed ${eventCount} events, ${seen.size} unique transactions`
  );
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  process.exit(0);
});
