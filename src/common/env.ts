import "dotenv/config";

export type Commitment = "processed" | "confirmed" | "finalized";

function parseList(name: string): string[] {
  const v = process.env[name]?.trim() ?? "";
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const ENV = {
  RPC_URL: process.env.RPC_URL || "",
  HTTP_RPC_URL: process.env.HTTP_RPC_URL || process.env.RPC_URL || "",
  COMMITMENT: (process.env.COMMITMENT || "confirmed") as Commitment,
  ORCA_POOLS: parseList("ORCA_POOLS"),
  RAYDIUM_POOLS: parseList("RAYDIUM_POOLS"),
  METEORA_DLMM_POOLS: parseList("METEORA_DLMM_POOLS"),
  METEORA_CPAMM_POOLS: parseList("METEORA_CPAMM_POOLS"),
  METEORA_DAMMV1_POOLS: parseList("METEORA_DAMMV1_POOLS"),
  HUMIDIFI_POOLS: parseList("HUMIDIFI_POOLS"),
  PUMPSWAP_POOLS: parseList("PUMPSWAP_POOLS"),
};

export function requireRpc(): void {
  if (!ENV.RPC_URL) {
    throw new Error("RPC_URL is required and must be a WebSocket endpoint.");
  }
}
