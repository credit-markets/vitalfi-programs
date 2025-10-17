# VitalFi Vault - Solana Program

A Solana smart contract implementing a multi-vault crowdfunding system for financing medical receivables in Brazil.

## 🏗️ Architecture

### Core Mechanics

Users deposit during the **Funding** phase up to the vault's capacity. After the funding period ends or when capacity is reached, the vault is finalized:

- **Success**: If `total_deposited ≥ ceil(2/3 * cap)` → Vault becomes **Active**, all funds withdrawn by authority
- **Failure**: If `total_deposited < ceil(2/3 * cap)` → Vault becomes **Canceled**, users can claim refunds

For successful vaults, the authority deploys funds off-chain to finance medical receivables. At maturity, the authority returns principal + yield to the vault and calls `mature_vault()`. Users can then claim their proportional payout.

### Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. INITIALIZATION                                                   │
│    Authority creates vault with:                                    │
│    • cap (max capacity)                                             │
│    • target_apy_bps (display only)                                  │
│    • funding_end_ts                                                 │
│    • maturity_ts                                                    │
│    • min_deposit                                                    │
│    • asset_mint (SPL token)                                         │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│ 2. FUNDING PHASE (Status: Funding)                                  │
│    Users deposit SPL tokens:                                        │
│    • deposit(amount) → Creates/updates Position PDA                 │
│    • Validates: time < funding_end_ts, amount ≥ min_deposit         │
│    • Enforces: total ≤ cap                                          │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│ 3. FINALIZATION (After funding_end_ts OR cap reached)               │
│    Authority calls finalize_funding():                              │
│                                                                     │
│    two_thirds = (cap * 2 + 2) / 3  // Safe ceiling                  │
│                                                                     │
│    if total_deposited < two_thirds:                                 │
│        └─> Status = Canceled                                        │
│            └─> Users claim full refunds                             │
│    else:                                                            │
│        └─> Status = Active                                          │
│            └─> ALL funds transferred to authority                   │
│                └─> Deploys off-chain to finance receivables         │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│ 4. MATURITY (Status: Active → Matured)                              │
│    Authority returns principal + yield to vault, calls:             │
│    • mature_vault()                                                 │
│    • Calculates payout factor:                                      │
│      payout_num = vault_token_account.amount (returned)             │
│      payout_den = total_deposited                                   │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│ 5. CLAIMS (Status: Matured OR Canceled)                             │
│    Users call claim():                                              │
│                                                                     │
│    If Matured:                                                      │
│      entitled = floor(deposited * payout_num / payout_den)          │
│    If Canceled:                                                     │
│      entitled = deposited  // Full refund                           │
│                                                                     │
│    to_pay = entitled - already_claimed                              │
│    • Supports multiple partial claims                               │
│    • Uses u128 math for precision                                   │
└─────────────────────────────────────────────────────────────────────┘
```

### State Accounts

**Vault PDA**: `["vault", authority, vault_id_bytes]`
- Stores all vault parameters and state
- 210 bytes

**Position PDA**: `["position", vault, user]`
- Tracks user's deposits and claims
- 89 bytes

**Vault Token Account**: `["vault_token", vault]`
- SPL token account holding deposits/returns
- Owned by Vault PDA

### Instructions

1. **initialize_vault** - Create new vault
2. **deposit** - User deposits during funding
3. **finalize_funding** - Check threshold, activate or cancel
4. **mature_vault** - Calculate payout factor after returns
5. **claim** - User claims refund or payout
6. **close_vault** - Close empty vault, reclaim rent

## 🚀 Installation

### Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) 1.75+
- [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools) 1.18+
- [Anchor Framework](https://www.anchor-lang.com/docs/installation) 0.31.1
- [Node.js](https://nodejs.org/) 18+ and Yarn

### Setup

```bash
# Clone repository
git clone <repository-url>
cd vitalfi-programs

# Install dependencies
yarn install

# Build program
anchor build
```

## 🧪 Tests

### Run All Tests

```bash
anchor test
```

## 🚢 Deployment

### Devnet

```bash
anchor deploy --provider.cluster devnet
```

### Mainnet

```bash
anchor deploy --provider.cluster mainnet
```

### Program ID

```
146hbPFqGb9a3v3t1BtkmftNeSNqXzoydzVPk95YtJNj
```

Configured in `Anchor.toml` and `lib.rs`.

## 📄 License

MIT

---

**Built with 💜 for healthcare finance on Solana**
