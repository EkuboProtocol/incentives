import { Account, RpcProvider } from "starknet";
import initializeIncentivesClient from "./util/initializeIncentivesClient.js";
import TelegramBot from "node-telegram-bot-api";
import { fetchTokens } from "./util/tokens.js";

// Environment variables for Telegram
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = parseInt(process.env.TELEGRAM_CHAT_ID);

// Starknet deployment configuration
const accountAddress = process.env.ACCOUNT_ADDRESS;
const privateKey = process.env.PRIVATE_KEY;
const nodeUrl = process.env.NODE_URL;

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (isNaN(TELEGRAM_CHAT_ID)) throw new Error("Invalid TELEGRAM_CHAT_ID");

if (!accountAddress || !privateKey || !nodeUrl) {
  throw new Error("Missing ACCOUNT_ADDRESS, PRIVATE_KEY, or NODE_URL");
}

const provider = new RpcProvider({ nodeUrl });

const deployerAccount = new Account(provider, accountAddress, privateKey);

const airdropClassHash =
  "0x01cb5e128a81be492ee7b78cf4ba4849cb35f311508e13a558755f4549839f14";

// Initialize Telegram bot if credentials are provided
const telegramBot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
  polling: false,
});

try {
  const chat = await telegramBot.getChat(TELEGRAM_CHAT_ID);
  if (!chat.permissions?.can_send_messages) {
    throw new Error(`Cannot send messages to the chat ID ${TELEGRAM_CHAT_ID}`);
  }
} catch (e) {
  throw new Error(
    `Failed to get telegram chat with ID "${TELEGRAM_CHAT_ID}": ${e.message}`,
  );
}

interface DropInfoFromDB {
  drop_id: string;
  root: string;
  reward_token: string;
  campaign_names: string[];
  min_start_time: Date | string;
  max_end_time: Date | string;
  drop_total_amount: string;
  period_total_amount: string;
  num_addresses: number;
  avg_amount: string;
  median_amount: string;
  max_amount: string;
}

interface DropInfo extends DropInfoFromDB {
  token_symbol: string;
  token_decimals: number;
}

/**
 * Escapes MarkdownV2 special characters to prevent parsing errors
 */
function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");
}

/**
 * Formats a number with 12 significant figures, rounded up
 */
function formatWithSignificantFigures(
  value: bigint,
  decimals: number,
  sigFigs: number = 12,
): string {
  if (value === 0n) return "0";

  // Convert BigInt to number with decimals
  const valueNum = Number(value) / Math.pow(10, decimals);

  // Calculate the order of magnitude
  const magnitude = Math.floor(Math.log10(Math.abs(valueNum)));

  // Calculate decimal places needed for sigFigs significant figures
  // Clamp to 0-20 to avoid RangeError in toLocaleString
  const decimalPlaces = Math.min(20, Math.max(0, sigFigs - magnitude - 1));

  // Round up
  const multiplier = Math.pow(10, decimalPlaces);
  const rounded = Math.ceil(valueNum * multiplier) / multiplier;

  // Format with thousand separators
  return rounded.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimalPlaces,
  });
}

/**
 * Sends a Telegram message about the deployed contract
 */
async function sendTelegramMessage(
  dropInfo: DropInfo,
  contractAddress: string,
): Promise<void> {
  // Statistics are computed in SQL (avg and median are numeric, max is already bigint)
  const avgAmount = BigInt(dropInfo.avg_amount.split(".")[0]);
  const medianAmount = BigInt(dropInfo.median_amount.split(".")[0]);
  const maxAmount = BigInt(dropInfo.max_amount);

  // Escape campaign names to prevent MarkdownV2 parsing issues
  const escapedCampaigns = dropInfo.campaign_names
    .map(escapeMarkdownV2)
    .join(", ");

  // Convert dates to Date objects if they're strings (pg returns timestamptz as strings)
  const startDate =
    dropInfo.min_start_time instanceof Date
      ? dropInfo.min_start_time
      : new Date(dropInfo.min_start_time);
  const endDate =
    dropInfo.max_end_time instanceof Date
      ? dropInfo.max_end_time
      : new Date(dropInfo.max_end_time);

  const message = `
🎉 *Airdrop Contract Deployed*

*Campaign\\(s\\):* ${escapedCampaigns}

*Drop Period:*
Start: \`${startDate.toISOString()}\`
End: \`${endDate.toISOString()}\`

*Contract Address:*
\`${contractAddress}\`

*Token:* ${escapeMarkdownV2(dropInfo.token_symbol)}

*Drop Amount:* \`${formatWithSignificantFigures(BigInt(dropInfo.drop_total_amount), dropInfo.token_decimals)} ${dropInfo.token_symbol}\`

*Campaign Total:* \`${formatWithSignificantFigures(BigInt(dropInfo.period_total_amount), dropInfo.token_decimals)} ${dropInfo.token_symbol}\`

*Recipients:* \`${dropInfo.num_addresses.toLocaleString()}\`

*Reward Statistics:*
• Average: \`${formatWithSignificantFigures(avgAmount, dropInfo.token_decimals)} ${dropInfo.token_symbol}\`
• Median: \`${formatWithSignificantFigures(medianAmount, dropInfo.token_decimals)} ${dropInfo.token_symbol}\`
• Maximum: \`${formatWithSignificantFigures(maxAmount, dropInfo.token_decimals)} ${dropInfo.token_symbol}\`
  `.trim();

  await telegramBot.sendMessage(TELEGRAM_CHAT_ID, message, {
    parse_mode: "MarkdownV2",
  });
}

// Fetch token metadata from API
const tokens = await fetchTokens(
  process.env.TOKENS_URL || "https://starknet-mainnet-api.ekubo.org/tokens",
);

const client = await initializeIncentivesClient();

try {
  // First, check for drops with multiple tokens and throw an error if any exist
  const { rows: multiTokenDrops } = await client.query<{
    drop_id: string;
    num_tokens: number;
    token_list: string[];
  }>({
    text: `
      SELECT
        gd.id::text AS drop_id,
        COUNT(DISTINCT c.reward_token) AS num_tokens,
        ARRAY_AGG(DISTINCT c.reward_token::text) AS token_list
      FROM incentives.generated_drop gd
      JOIN incentives.generated_drop_reward_periods gdrp ON gd.id = gdrp.drop_id
      JOIN incentives.campaign_reward_periods crp ON gdrp.campaign_reward_period_id = crp.id
      JOIN incentives.campaigns c ON crp.campaign_id = c.id
      WHERE gd.id NOT IN (SELECT drop_id FROM incentives.deployed_airdrop_contracts)
      GROUP BY gd.id
      HAVING COUNT(DISTINCT c.reward_token) > 1
    `,
  });

  if (multiTokenDrops.length > 0) {
    const dropDetails = multiTokenDrops
      .map(
        (d) =>
          `Drop ID ${d.drop_id}: ${d.num_tokens} tokens (${d.token_list.join(", ")})`,
      )
      .join("\n");
    throw new Error(
      `Found generated drops with multiple reward tokens:\n${dropDetails}`,
    );
  }

  // Query for all generated drops that haven't been deployed yet
  const { rows: drops } = await client.query<DropInfoFromDB>({
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
          AVG(amount) AS avg_amount,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY amount DESC) AS median_amount,
          MAX(amount) AS max_amount
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
        da.avg_amount::text,
        da.median_amount::text,
        da.max_amount::text
      FROM drop_info di
      JOIN drop_amounts da ON di.drop_id = da.drop_id
      ORDER BY di.drop_id
    `,
  });

  if (drops.length === 0) {
    console.log("No drops to deploy");
    process.exit(0);
  }

  console.log(`Found ${drops.length} drop(s) to deploy`);

  // Build a map for efficient token lookups
  const tokenByAddress = new Map(
    tokens.map((t) => [BigInt(t.l2_token_address).toString(), t]),
  );

  for (const dropFromDB of drops) {
    console.log(`\nProcessing drop ID ${dropFromDB.drop_id}`);

    // Get token information from map
    const token = tokenByAddress.get(
      BigInt(dropFromDB.reward_token).toString(),
    );

    if (!token) {
      throw new Error(
        `Token not found for address: ${dropFromDB.reward_token}`,
      );
    }

    const tokenInfo = {
      symbol: token.symbol,
      decimals: token.decimals,
    };

    // Create enriched drop info with token metadata
    const drop: DropInfo = {
      ...dropFromDB,
      token_symbol: tokenInfo.symbol,
      token_decimals: tokenInfo.decimals,
    };

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

    // Must send telegram message before inserting the row
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
