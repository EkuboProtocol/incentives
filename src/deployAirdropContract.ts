import { Account, RpcProvider } from "starknet";
import initializeIncentivesClient from "./util/initializeIncentivesClient.js";
import TelegramBot from "node-telegram-bot-api";

// Environment variables for Telegram
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Starknet deployment configuration
const accountAddress = process.env.ACCOUNT_ADDRESS;
const privateKey = process.env.PRIVATE_KEY;
const provider = new RpcProvider({ nodeUrl: process.env.NODE_URL });

if (!accountAddress || !privateKey) {
  throw new Error("Missing ACCOUNT_ADDRESS or PRIVATE_KEY");
}

const deployerAccount = new Account(provider, accountAddress, privateKey);

const airdropClassHash =
  "0x01cb5e128a81be492ee7b78cf4ba4849cb35f311508e13a558755f4549839f14";

// Initialize Telegram bot if credentials are provided
let telegramBot: TelegramBot | null = null;
if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
  telegramBot = new TelegramBot(TELEGRAM_BOT_TOKEN);
}

interface DropInfo {
  drop_id: string;
  root: string;
  reward_token: string;
  token_symbol: string;
  token_decimals: number;
  campaign_names: string[];
  min_start_time: Date;
  max_end_time: Date;
  drop_total_amount: string;
  period_total_amount: string;
  num_addresses: number;
  amounts: string[];
}

/**
 * Formats a number with 12 significant figures, rounded up
 */
function formatWithSignificantFigures(
  value: bigint,
  decimals: number,
  sigFigs: number = 12,
): string {
  const valueNum = Number(value) / Math.pow(10, decimals);

  if (valueNum === 0) return "0";

  // Calculate the order of magnitude
  const magnitude = Math.floor(Math.log10(Math.abs(valueNum)));

  // Calculate decimal places needed for sigFigs significant figures
  const decimalPlaces = Math.max(0, sigFigs - magnitude - 1);

  // Round up by adding a small epsilon before rounding
  const epsilon = Math.pow(10, -(decimalPlaces + 1));
  const rounded =
    Math.ceil((valueNum + epsilon) * Math.pow(10, decimalPlaces)) /
    Math.pow(10, decimalPlaces);

  // Format with thousand separators
  return rounded.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimalPlaces,
  });
}

/**
 * Calculates median from an array of bigint amounts
 */
function calculateMedian(amounts: bigint[]): bigint {
  if (amounts.length === 0) return 0n;

  const sorted = [...amounts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2n;
  } else {
    return sorted[mid];
  }
}

/**
 * Sends a Telegram message about the deployed contract
 */
async function sendTelegramMessage(
  dropInfo: DropInfo,
  contractAddress: string,
): Promise<void> {
  if (!telegramBot || !TELEGRAM_CHAT_ID) {
    console.log("Telegram not configured, skipping message");
    return;
  }

  const amounts = dropInfo.amounts.map((a) => BigInt(a));
  const avgAmount =
    amounts.reduce((sum, a) => sum + a, 0n) / BigInt(amounts.length);
  const medianAmount = calculateMedian(amounts);
  const maxAmount = amounts.reduce((max, a) => (a > max ? a : max), 0n);

  const message = `
🎉 *Airdrop Contract Deployed*

*Campaign(s):* ${dropInfo.campaign_names.join(", ")}

*Drop Period:*
Start: ${dropInfo.min_start_time.toISOString()}
End: ${dropInfo.max_end_time.toISOString()}

*Contract Address:*
\`${contractAddress}\`

*Token:* ${dropInfo.token_symbol}

*Drop Amount:* ${formatWithSignificantFigures(BigInt(dropInfo.drop_total_amount), dropInfo.token_decimals)} ${dropInfo.token_symbol}

*Campaign Total:* ${formatWithSignificantFigures(BigInt(dropInfo.period_total_amount), dropInfo.token_decimals)} ${dropInfo.token_symbol}

*Recipients:* ${dropInfo.num_addresses.toLocaleString()}

*Reward Statistics:*
• Average: ${formatWithSignificantFigures(avgAmount, dropInfo.token_decimals)} ${dropInfo.token_symbol}
• Median: ${formatWithSignificantFigures(medianAmount, dropInfo.token_decimals)} ${dropInfo.token_symbol}
• Maximum: ${formatWithSignificantFigures(maxAmount, dropInfo.token_decimals)} ${dropInfo.token_symbol}
  `.trim();

  try {
    await telegramBot.sendMessage(TELEGRAM_CHAT_ID, message, {
      parse_mode: "Markdown",
    });
    console.log("Telegram message sent successfully");
  } catch (error) {
    console.error("Failed to send Telegram message:", error);
  }
}

const client = await initializeIncentivesClient();

try {
  // Query for all generated drops that haven't been deployed yet
  const { rows: drops } = await client.query<DropInfo>({
    text: `
      WITH drop_info AS (
        SELECT
          gd.id AS drop_id,
          gd.root,
          ARRAY_AGG(DISTINCT c.name ORDER BY c.name) AS campaign_names,
          ARRAY_AGG(DISTINCT c.reward_token) AS reward_tokens,
          MIN(crp.start_time) AS min_start_time,
          MAX(crp.end_time) AS max_end_time,
          SUM(crp.token0_reward_amount + crp.token1_reward_amount) AS period_total_amount
        FROM incentives.generated_drop gd
        JOIN incentives.generated_drop_reward_periods gdrp ON gd.id = gdrp.drop_id
        JOIN incentives.campaign_reward_periods crp ON gdrp.campaign_reward_period_id = crp.id
        JOIN incentives.campaigns c ON crp.campaign_id = c.id
        WHERE gd.id NOT IN (SELECT drop_id FROM incentives.deployed_airdrop_contracts)
        GROUP BY gd.id, gd.root
      ),
      drop_amounts AS (
        SELECT
          drop_id,
          SUM(amount) AS drop_total_amount,
          COUNT(*) AS num_addresses,
          ARRAY_AGG(amount ORDER BY amount DESC) AS amounts
        FROM incentives.generated_drop_proof
        GROUP BY drop_id
      )
      SELECT
        di.drop_id::text,
        di.root::text,
        di.reward_tokens[1]::text AS reward_token,
        di.campaign_names,
        di.min_start_time,
        di.max_end_time,
        da.drop_total_amount::text,
        di.period_total_amount::text,
        da.num_addresses::int,
        da.amounts::text[]
      FROM drop_info di
      JOIN drop_amounts da ON di.drop_id = da.drop_id
      WHERE ARRAY_LENGTH(di.reward_tokens, 1) = 1
      ORDER BY di.drop_id
    `,
  });

  if (drops.length === 0) {
    console.log("No drops to deploy");
    await client.end();
    process.exit(0);
  }

  console.log(`Found ${drops.length} drop(s) to deploy`);

  // Get token information (symbol and decimals)
  // For Starknet, we'll need to query this from the token contract or use a known mapping
  // For now, we'll assume STRK token with 18 decimals as a default
  const TOKEN_INFO: Record<string, { symbol: string; decimals: number }> = {
    "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d": {
      symbol: "STRK",
      decimals: 18,
    },
  };

  for (const drop of drops) {
    console.log(`\nProcessing drop ID ${drop.drop_id}`);

    // Validate that all periods use the same token
    const tokenInfo = TOKEN_INFO[drop.reward_token] || {
      symbol: "UNKNOWN",
      decimals: 18,
    };

    drop.token_symbol = tokenInfo.symbol;
    drop.token_decimals = tokenInfo.decimals;

    const root = BigInt(drop.root);
    const distributedToken = BigInt(drop.reward_token);

    const constructorCalldata = [distributedToken, root, "0x0", "0x0"];
    console.log(
      `Deploying airdrop with class hash ${airdropClassHash} and arguments`,
      constructorCalldata,
    );

    const deployResponse = await deployerAccount.deployContract({
      classHash: airdropClassHash,
      constructorCalldata,
    });

    await provider.waitForTransaction(deployResponse.transaction_hash);

    console.log("Deployed airdrop");
    console.log("Contract address:", deployResponse.contract_address);

    await client.query({
      text: `
        INSERT INTO incentives.deployed_airdrop_contracts (address, token, drop_id)
        VALUES ($1, $2, $3);
      `,
      values: [
        BigInt(deployResponse.contract_address),
        distributedToken,
        BigInt(drop.drop_id),
      ],
    });

    console.log("Inserted airdrop row");

    // Send Telegram message
    await sendTelegramMessage(drop, deployResponse.contract_address);

    console.log(`Successfully deployed drop ID ${drop.drop_id}`);
  }

  console.log(`\nSuccessfully deployed ${drops.length} drop(s)`);
} catch (error) {
  console.error("Error deploying drops:", error);
  throw error;
} finally {
  await client.end();
}
