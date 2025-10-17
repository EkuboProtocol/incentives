# Incentive Query

This repository contains scripts for managing Ekubo Protocol incentive campaigns and airdrops.

## Scripts

### Deploy Airdrop Contract (`deployAirdropContract.ts`)

Automatically deploys airdrop contracts for all generated drops that haven't been deployed yet.

**Features:**

- Finds all undeployed generated drops
- Validates that each drop uses a single token
- Deploys airdrop contracts to Starknet
- Sends Telegram notifications with deployment details

**Environment Variables:**

- `ACCOUNT_ADDRESS` - Starknet account address for deployment (required)
- `PRIVATE_KEY` - Private key for the deployment account (required)
- `NODE_URL` - Starknet RPC node URL (required)
- `TELEGRAM_BOT_TOKEN` - Telegram bot token for notifications (optional)
- `TELEGRAM_CHAT_ID` - Telegram chat ID to send notifications to (optional)
- Database connection variables: `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`

**Telegram Message Format:**

When configured, the script sends a message for each deployed contract containing:

- Campaign name(s) associated with the drop
- Drop start and end times (min/max of reward periods)
- Deployed contract address (hex format)
- Total token amount in the drop (formatted with 12 significant figures, rounded up)
- Total token amount in the campaign reward periods (before filtering)
- Number of recipient addresses
- Reward statistics: average, median, and maximum rewards

**Usage:**

```bash
npm run deploy-airdrop-contract
```

**GitHub Actions:**

The workflow can be triggered manually via GitHub Actions. It will automatically deploy all pending drops and send Telegram notifications.

### Generate Drop (`generateDrop.ts`)

Generates merkle drops from computed rewards and optionally uploads CSV files to Telegram.

**Features:**

- Queries pending drops from computed reward periods
- Generates merkle trees and proofs for each drop
- Filters allocations based on minimum thresholds
- Uploads CSV files with allocation data to Telegram (optional)

**Environment Variables:**

- `NETWORK_TYPE` - Network type: `STARKNET` or `EVM` (required)
- `POSITIONS_LOCKER_ADDRESS` - Address of the positions locker contract (required)
- `TELEGRAM_BOT_TOKEN` - Telegram bot token for CSV uploads (optional)
- `TELEGRAM_CHAT_ID` - Telegram chat ID to send CSV files to (optional)
- Database connection variables: `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`

**Telegram CSV Upload:**

When `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are configured, the script automatically uploads a CSV file for each generated drop containing:

- **CSV Columns:**
  - `address` - Recipient address (raw bigint)
  - `amount` - Token amount (raw bigint)
  - `amount_formatted` - Token amount divided by 1e18 for readability

- **Message Caption includes:**
  - Campaign slug
  - Database and network type
  - Drop ID and reward period IDs
  - Period date range
  - Total amount and number of recipients
  - Minimum allocation threshold
  - Statistics on filtered allocations

**Usage:**

```bash
npm run generate-drop
```

**GitHub Actions:**

The workflow runs daily at 12:00 UTC and can be triggered manually. It processes drops for all configured networks (Ethereum mainnet/sepolia and Starknet mainnet/sepolia).

### Other Scripts

- `sync-defi-spring` - Syncs DeFi Spring campaign data
- `sync-btcfi` - Syncs BTC-Fi campaign data
- `compute-distributions` - Computes reward distributions
- `fund-drops` - Funds deployed airdrop contracts

## Development

### Setup

```bash
npm install
```

### Testing

```bash
npm test
```

### Formatting

```bash
npm run format
```

## Database Schema

The scripts interact with a PostgreSQL database containing:

- `incentives.campaigns` - Campaign definitions
- `incentives.campaign_reward_periods` - Reward periods for campaigns
- `incentives.computed_rewards` - Computed rewards for positions
- `incentives.generated_drop` - Generated merkle drops
- `incentives.generated_drop_reward_periods` - Links drops to reward periods
- `incentives.generated_drop_proof` - Merkle proofs for drop claims
- `incentives.deployed_airdrop_contracts` - Deployed contract addresses
