import { Account, RpcProvider } from "starknet";
import TelegramBot from "node-telegram-bot-api";
import postgres from "postgres";

// Environment variables for Telegram
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Starknet deployment configuration
const accountAddress = process.env.ACCOUNT_ADDRESS;
const privateKey = process.env.PRIVATE_KEY;
const nodeUrl = process.env.NODE_URL;

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");

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
  const me = await telegramBot.getMe();
  const member = await telegramBot.getChatMember(TELEGRAM_CHAT_ID, me.id);

  if (member.status !== "member") {
    throw new Error("Bot is not a member of the given TELEGRAM_CHAT_ID");
  }
} catch (e) {
  throw new Error(
    `Failed to get telegram chat with ID "${TELEGRAM_CHAT_ID}": ${e.message}`,
  );
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

interface DropInfo {
  drop_id: string;
  root: string;
  reward_token: string;
  token_symbol: string;
  token_decimals: number;
  campaign_name: string;
  min_start_time: Date;
  max_end_time: Date;
  drop_total_amount: string;
  period_total_amount: string;
  num_addresses: number;
  avg_amount: string;
  median_amount: string;
  max_amount: string;
}

/**
 * Sends a Telegram message about the deployed contract
 */
async function sendTelegramMessage(
  dropInfo: DropInfo,
  contractAddress: string,
): Promise<void> {
  // Statistics are computed in SQL (avg and median are numeric, max is already bigint)
  const avgAmount = BigInt(Math.floor(Number(dropInfo.avg_amount)));
  const medianAmount = BigInt(Math.floor(Number(dropInfo.median_amount)));
  const maxAmount = BigInt(dropInfo.max_amount);

  // Escape campaign names to prevent MarkdownV2 parsing issues
  const escapedCampaigns = escapeMarkdownV2(dropInfo.campaign_name);

  // Convert dates to Date objects if they're strings (postgres returns timestamptz as strings)
  const startDate =
    dropInfo.min_start_time instanceof Date
      ? dropInfo.min_start_time
      : new Date(dropInfo.min_start_time);
  const endDate =
    dropInfo.max_end_time instanceof Date
      ? dropInfo.max_end_time
      : new Date(dropInfo.max_end_time);

  const message = `
*Deployed Airdrop for Campaign\\(s\\):* ${escapedCampaigns}

*Drop Period:* \`${startDate.toISOString()}\` to \`${endDate.toISOString()}\`
*Contract Address:* \`${contractAddress}\`

*Drop Amount:* \`${formatWithSignificantFigures(BigInt(dropInfo.drop_total_amount), dropInfo.token_decimals)} ${dropInfo.token_symbol}\`
*Period Total:* \`${formatWithSignificantFigures(BigInt(dropInfo.period_total_amount), dropInfo.token_decimals)} ${dropInfo.token_symbol}\`

*Reward Statistics:*
• Number of recipients: \`${dropInfo.num_addresses.toLocaleString()}\`
• Average: \`${formatWithSignificantFigures(avgAmount, dropInfo.token_decimals)} ${dropInfo.token_symbol}\`
• Median: \`${formatWithSignificantFigures(medianAmount, dropInfo.token_decimals)} ${dropInfo.token_symbol}\`
• Maximum: \`${formatWithSignificantFigures(maxAmount, dropInfo.token_decimals)} ${dropInfo.token_symbol}\`
  `.trim();

  await telegramBot.sendMessage(TELEGRAM_CHAT_ID, message, {
    parse_mode: "MarkdownV2",
  });
}

const sql = postgres({
  ssl: "prefer",
  types: { bigint: postgres.BigInt },
});

try {
  // Query for all generated drops that haven't been deployed yet
  const drops = await sql<DropInfo[]>`
WITH drop_info AS (SELECT gd.id                                                    AS drop_id,
                          gd.root,
                          ARRAY_AGG(DISTINCT c.id)                                 AS campaign_ids,
                          MIN(crp.start_time)                                      AS min_start_time,
                          MAX(crp.end_time)                                        AS max_end_time,
                          SUM(crp.token0_reward_amount + crp.token1_reward_amount) AS period_total_amount
                   FROM incentives.generated_drop gd
                            JOIN incentives.generated_drop_reward_periods gdrp ON gd.id = gdrp.drop_id
                            JOIN incentives.campaign_reward_periods crp ON gdrp.campaign_reward_period_id = crp.id
                            JOIN incentives.campaigns c ON crp.campaign_id = c.id
                   WHERE gd.id NOT IN (SELECT drop_id FROM incentives.deployed_airdrop_contracts)
                     AND gd.root NOT IN (SELECT root FROM incentives_funded)
                   GROUP BY gd.id, gd.root),
     drop_amounts AS (SELECT drop_id,
                             SUM(amount)                                              AS drop_total_amount,
                             COUNT(*)                                                 AS num_addresses,
                             AVG(amount)                                              AS avg_amount,
                             PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY amount DESC) AS median_amount,
                             MAX(amount)                                              AS max_amount
                      FROM incentives.generated_drop_proof
                      GROUP BY drop_id)
SELECT di.drop_id::TEXT,
       di.root::TEXT,
       c.reward_token::TEXT AS reward_token,
       token_symbol,
       token_decimals,
       c.name               AS campaign_name,
       di.min_start_time,
       di.max_end_time,
       da.drop_total_amount::TEXT,
       di.period_total_amount::TEXT,
       da.num_addresses::INT,
       da.avg_amount::TEXT,
       da.median_amount::TEXT,
       da.max_amount::TEXT
FROM drop_info di
         JOIN drop_amounts da ON di.drop_id = da.drop_id
         JOIN incentives.campaigns c ON di.campaign_ids[1] = c.id
         JOIN erc20_tokens t ON t.chain_id = c.chain_id AND t.token_address = c.reward_token
WHERE ARRAY_LENGTH(di.campaign_ids, 1) = 1
ORDER BY di.drop_id
    `;

  if (drops.length === 0) {
    console.log("No drops to deploy");
    process.exit(0);
  }

  console.log(`Found ${drops.length} drop(s) to deploy`);

  for (const drop of drops) {
    console.log(`\nProcessing drop ID ${drop.drop_id}`);

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

    await sql`
      INSERT INTO incentives.deployed_airdrop_contracts (address, token, drop_id)
      VALUES (${BigInt(deployResponse.contract_address).toString()}, ${distributedToken.toString()}, ${BigInt(drop.drop_id)});
    `;

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
  await sql.end({ timeout: 5 });
}
