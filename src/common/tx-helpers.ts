import {
  AddressLookupTableAccount,
  Connection,
  PublicKey,
  TransactionResponse,
  VersionedTransactionResponse,
} from "@solana/web3.js";

export async function fetchTx(
  connection: Connection,
  signature: string,
  commitment: "processed" | "confirmed" | "finalized"
): Promise<VersionedTransactionResponse | null> {
  try {
    const tx = await connection.getTransaction(signature, {
      commitment,
      maxSupportedTransactionVersion: 0,
    });
    return tx;
  } catch (error) {
    console.error(
      `Error fetching tx ${signature.slice(0, 8)}:`,
      (error as Error).message
    );
    return null;
  }
}

export async function getBlockTimeMsFallback(
  connection: Connection,
  slot: number
): Promise<number | null> {
  try {
    const sec = await connection.getBlockTime(slot);
    return sec != null ? sec * 1000 : null;
  } catch (error) {
    console.error(
      `Error fetching block time for slot ${slot}:`,
      (error as Error).message
    );
    return null;
  }
}

export function flattenAllAccounts(tx: VersionedTransactionResponse): string[] {
  try {
    const accountKeys = tx.transaction.message.getAccountKeys();
    const allAccounts: string[] = [];

    // Static account keys (always present)
    allAccounts.push(...accountKeys.staticAccountKeys.map((k) => k.toBase58()));

    // Loaded addresses from lookup tables (if present)
    if (accountKeys.accountKeysFromLookups) {
      allAccounts.push(
        ...accountKeys.accountKeysFromLookups.writable.map((k) => k.toBase58())
      );
      allAccounts.push(
        ...accountKeys.accountKeysFromLookups.readonly.map((k) => k.toBase58())
      );
    }

    return Array.from(new Set(allAccounts));
  } catch (error) {
    // Fallback: just return static keys if lookup resolution fails
    console.warn("Failed to resolve lookup tables, using static keys only");
    return tx.transaction.message.staticAccountKeys.map((k) => k.toBase58());
  }
}

export function guessInstructionLabel(
  logs: string[] | null | undefined
): string | null {
  if (!logs) return null;
  const ln = logs.find((l) => l.includes("Instruction:"));
  if (!ln) return null;
  // Typical: "Program log: Instruction: Swap"
  const idx = ln.lastIndexOf("Instruction:");
  return idx >= 0 ? ln.slice(idx + "Instruction:".length).trim() : null;
}

export function poolMentionedInTx(
  allAccounts: string[],
  poolKeys: Set<string>
): string | null {
  for (const acc of allAccounts) {
    if (poolKeys.has(acc)) return acc;
  }
  return null;
}

// import {
//   AddressLookupTableAccount,
//   Connection,
//   PublicKey,
//   TransactionResponse,
// } from "@solana/web3.js";

// export async function fetchTx(
//   connection: Connection,
//   signature: string,
//   commitment: "processed" | "confirmed" | "finalized"
// ): Promise<TransactionResponse | null> {
//   // getTransaction includes blockTime (sec) when available
//   return await connection.getTransaction(signature, {
//     commitment,
//     maxSupportedTransactionVersion: 0,
//   });
// }

// export async function getBlockTimeMsFallback(
//   connection: Connection,
//   slot: number
// ): Promise<number | null> {
//   const sec = await connection.getBlockTime(slot);
//   return sec != null ? sec * 1000 : null;
// }

// export function flattenAllAccounts(tx: TransactionResponse): string[] {
//   const staticKeys = tx.transaction.message
//     .getAccountKeys()
//     .staticAccountKeys.map((k) => k.toBase58());
//   // include loaded address table keys if present
//   const loaded = tx.meta?.loadedAddresses;
//   const writables = loaded?.writable?.map((k) => k.toBase58()) ?? [];
//   const readonlys = loaded?.readonly?.map((k) => k.toBase58()) ?? [];
//   return Array.from(new Set([...staticKeys, ...writables, ...readonlys]));
// }

// export function guessInstructionLabel(
//   logs: string[] | null | undefined
// ): string | null {
//   if (!logs) return null;
//   const ln = logs.find((l) => l.includes("Instruction:"));
//   if (!ln) return null;
//   // Typical: "Program log: Instruction: Swap"
//   const idx = ln.lastIndexOf("Instruction:");
//   return idx >= 0 ? ln.slice(idx + "Instruction:".length).trim() : null;
// }

// export function poolMentionedInTx(
//   allAccounts: string[],
//   poolKeys: Set<string>
// ): string | null {
//   for (const acc of allAccounts) {
//     if (poolKeys.has(acc)) return acc;
//   }
//   return null;
// }
