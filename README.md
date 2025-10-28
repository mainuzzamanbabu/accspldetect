# 📚 Complete Guide: Adding New DEXes

## Quick Start: Adding Orca Whirlpools

The code I provided already includes Orca! Just verify the pool address:

1. **Find your desired Orca pool**: Visit [Orca.so](https://www.orca.so/)
2. **Get pool address**: Check the pool's Solscan page
3. **Add to config**:

```typescript
{
  name: "Orca_Whirlpools",
  programId: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  enabled: true, // Change this to true
  pools: [
    {
      address: "7qbRF6YsyGuLUjEqTTdWrspzLSWs8Y4XbLFYuGxe5gPM",
      tokenA: SOL_MINT,
      tokenB: USDC_MINT,
      tokenASymbol: "SOL",
      tokenBSymbol: "USDC",
      decimalsA: 9,
      decimalsB: 6,
    },
  ],
}
```

---

## Adding Meteora DLMM (Medium Difficulty)

### 1. Find Pool Address

Visit [Meteora DLMM](https://app.meteora.ag/dlmm) and find your pool.

### 2. Add to Configuration

```typescript
{
  name: "Meteora_DLMM",
  programId: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  enabled: true,
  pools: [
    {
      address: "YOUR_METEORA_POOL_ADDRESS",
      tokenA: SOL_MINT,
      tokenB: USDC_MINT,
      tokenASymbol: "SOL",
      tokenBSymbol: "USDC",
      decimalsA: 9,
      decimalsB: 6,
    },
  ],
}
```

### 3. Add Meteora Parser

```typescript
// In DEX DETECTION section
if (logsLower.some(log => log.includes("lbpair") || log.includes("meteora"))) {
  return "Meteora_DLMM";
}

// In UNIFIED SWAP PARSER section
case "Meteora_DLMM":
  return parseMeteoraSwap(preBalances, postBalances, poolInfo.pool);
```

### 4. Create Meteora Parser

```typescript
function parseMeteoraSwap(
  preBalances: any[],
  postBalances: any[],
  poolConfig: PoolConfig
): SwapData | null {
  // Meteora uses bin-based liquidity
  // For basic tracking, can use token balance method like CLMM
  return parseClmmSwap(preBalances, postBalances, poolConfig);

  // For advanced: parse bin data from account updates
  // (requires subscribing to account changes, not just transactions)
}
```

---

## Finding Pool Addresses

### Method 1: From DEX Website

1. Go to the DEX (Orca, Meteora, etc.)
2. Find your token pair
3. Click on the pool
4. Look for "Pool Address" or "Contract Address"
5. Open in Solscan to verify

### Method 2: From Solscan

1. Go to [Solscan.io](https://solscan.io)
2. Search for the token pair
3. Look at recent swap transactions
4. Find the pool account address
5. Verify program ID matches

### Method 3: From SDK/Docs

- **Raydium**: [SDK docs](https://github.com/raydium-io/raydium-sdk)
- **Orca**: [API](https://www.orca.so/api)
- **Meteora**: [Docs](https://docs.meteora.ag/)

---

## Token Mint Addresses (Common Pairs)

```typescript
// Stablecoins
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

// Native tokens
const SOL_MINT = "So11111111111111111111111111111111111111112";
const mSOL_MINT = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
const stSOL_MINT = "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj";

// Other popular
const RAY_MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const JUP_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const BONK_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
```

---

## Testing New DEXes

### 1. Start with One Pool

```typescript
enabled: true,
pools: [
  // Add just ONE pool initially
  { address: "...", ... }
]
```

### 2. Monitor Output

Look for:

- ✅ Transactions detected
- ✅ DEX name correct
- ✅ Price calculation working
- ✅ Token symbols correct

### 3. Common Issues

**Issue**: No transactions detected

- Check: Pool address is correct
- Check: DEX is `enabled: true`
- Check: Pool has recent activity (check Solscan)

**Issue**: Wrong DEX name

- Add log pattern in `detectDex()` function
- Check program ID matches

**Issue**: Price is 0 or null

- Check: Token mint addresses are correct
- Check: Decimals are correct
- Check: Parser is handling this DEX type

**Issue**: Price looks inverted

- Swap `tokenA` and `tokenB` in config
- Or adjust calculation in parser

---

## Advanced: Subscribing to Account Changes

For some DEXes (like Meteora bins or Phoenix order books), you need account data:

```typescript
const request: SubscribeRequest = {
  accounts: {
    meteora_bins: {
      account: ["YOUR_BIN_ADDRESSES"],
      owner: [],
      filters: [],
    },
  },
  transactions: {
    // ... existing config
  },
  // ... rest of config
};

stream.on("data", (data) => {
  if (data.account) {
    // Process account update
    const accountData = data.account.account.data;
    // Parse bin data, order book, etc.
  }

  if (data.transaction) {
    // Process transaction (existing code)
  }
});
```

---

## Performance Optimization Tips

### 1. Disable Unused DEXes

```typescript
enabled: false, // If you don't need this DEX
```

### 2. Limit Pools

Only monitor pools you actually trade:

```typescript
pools: [
  // Only add pools you care about
];
```

### 3. Disable Block Time Fetch

```typescript
const ENABLE_BLOCK_TIME_FETCH = false; // Save 50-200ms
```

### 4. Reduce Logging

```typescript
// Comment out console.logs you don't need
// Or log to file instead of console
```

---

## Multi-DEX Statistics Tracking

Add tracking to compare DEXes:

```typescript
const dexStats = {
  Raydium_CLMM: { count: 0, totalVolume: 0 },
  Orca_Whirlpools: { count: 0, totalVolume: 0 },
  Meteora_DLMM: { count: 0, totalVolume: 0 },
};

// In processTransaction:
if (swapData) {
  dexStats[dexName].count++;
  dexStats[dexName].totalVolume += swapData.amountOut;
}

// On shutdown:
process.on("SIGINT", () => {
  console.log("\n📊 DEX Statistics:");
  for (const [dex, stats] of Object.entries(dexStats)) {
    console.log(
      `${dex}: ${stats.count} swaps, ${stats.totalVolume.toFixed(2)} total`
    );
  }
  process.exit(0);
});
```

---

## Full DEX List Reference

| DEX             | Program ID                                     | Difficulty         | Notes                         |
| --------------- | ---------------------------------------------- | ------------------ | ----------------------------- |
| Raydium CLMM    | `CAMMCzo...`                                   | ⭐ Easy            | Included                      |
| Orca Whirlpools | `whirLbMi...`                                  | ⭐ Easy            | Included                      |
| Raydium AMM v4  | `675kPX9M...`                                  | ⭐⭐ Medium        | Included (disabled)           |
| Meteora DLMM    | `LBUZKhRx...`                                  | ⭐⭐⭐ Hard        | Bin-based, needs account data |
| Phoenix         | `PhoeNiXZ...`                                  | ⭐⭐⭐⭐ Very Hard | Order book, complex           |
| Lifinity        | `EewxydAPCCVuNEyrVN68PuSYdQ7wKn27V9Gjeoi8dy3S` | ⭐⭐ Medium        | Proactive market maker        |
| Mercurial       | `MERLuDFBMmsHnsBPZw2sDQZHvXFMwp8EdjudcU2HKky`  | ⭐⭐ Medium        | Stable swaps                  |

---

## Troubleshooting Checklist

- [ ] Pool address is correct (verified on Solscan)
- [ ] Program ID matches DEX
- [ ] DEX is `enabled: true`
- [ ] Token mints are correct
- [ ] Decimals match token specs
- [ ] Pool has recent activity
- [ ] gRPC connection is working
- [ ] Logs show transaction detection
- [ ] Parser handles this DEX type
- [ ] Token symbols display correctly

---

## Next Steps

1. **Start Simple**: Enable Orca (already in code)
2. **Test Thoroughly**: Monitor for 1 hour
3. **Compare Prices**: Verify against DEX UI
4. **Add More**: Once confident, add Meteora
5. **Optimize**: Disable unused features
6. **Scale Up**: Consider premium gRPC endpoint

**Pro Tip**: Use multiple terminals to test one DEX at a time during development!
