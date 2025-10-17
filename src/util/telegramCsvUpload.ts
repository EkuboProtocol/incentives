import TelegramBot from "node-telegram-bot-api";
import { Allocation } from "./airdrop.js";

export interface DropInfo {
  slug: string;
  dropId: number;
  periodIds: string[];
  firstStartTime: Date | string;
  lastEndTime: Date | string;
  minimumAllocation: bigint;
  filteredStats: { amount: bigint; count: number };
  database: string;
  networkType: string;
}

/**
 * Safely formats a BigInt amount with 18 decimals to avoid precision loss
 */
function formatAmount(amount: bigint): string {
  const integerPart = amount / 1000000000000000000n;
  const fractionalPart = amount % 1000000000000000000n;

  if (fractionalPart === 0n) {
    return integerPart.toString();
  }

  // Pad fractional part to 18 digits and trim trailing zeros
  const fractionalStr = fractionalPart
    .toString()
    .padStart(18, "0")
    .replace(/0+$/, "");
  return `${integerPart}.${fractionalStr}`;
}

/**
 * Sanitizes a string for use in filenames
 */
function sanitizeFilename(str: string): string {
  return str.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Generates a CSV string from allocations
 */
export function generateCsv(allocations: Allocation[]): string {
  const header = "address,amount,amount_formatted\n";
  const rows = allocations
    .map(
      ({ address, amount }) =>
        `${address.toString()},${amount.toString()},${formatAmount(amount)}`,
    )
    .join("\n");
  return header + rows;
}

/**
 * Uploads a CSV file to Telegram
 */
export async function uploadCsvToTelegram(
  allocations: Allocation[],
  dropInfo: DropInfo,
): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.log(
      "Skipping Telegram upload: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set",
    );
    return;
  }

  try {
    const bot = new TelegramBot(botToken, { polling: false });

    const csv = generateCsv(allocations);
    const buffer = Buffer.from(csv, "utf-8");

    const sum = allocations.reduce((memo, { amount }) => memo + amount, 0n);
    const formattedSum = formatAmount(sum);

    // Normalize dates (postgres may return strings)
    const startDate =
      dropInfo.firstStartTime instanceof Date
        ? dropInfo.firstStartTime
        : new Date(dropInfo.firstStartTime);
    const endDate =
      dropInfo.lastEndTime instanceof Date
        ? dropInfo.lastEndTime
        : new Date(dropInfo.lastEndTime);

    // Truncate period IDs if too many to avoid exceeding Telegram's 1024 char caption limit
    const maxPeriods = 10;
    const periodsList =
      dropInfo.periodIds.length > maxPeriods
        ? `${dropInfo.periodIds.slice(0, maxPeriods).join(", ")} (+${dropInfo.periodIds.length - maxPeriods} more)`
        : dropInfo.periodIds.join(", ");

    const caption = [
      `📊 Drop Generated`,
      ``,
      `Campaign: ${dropInfo.slug}`,
      `Database: ${dropInfo.database}`,
      `Network: ${dropInfo.networkType}`,
      `Drop ID: ${dropInfo.dropId}`,
      `Periods: ${periodsList}`,
      `Period Range: ${startDate.toISOString()} to ${endDate.toISOString()}`,
      ``,
      `Total Amount: ${formattedSum} tokens`,
      `Recipients: ${allocations.length.toLocaleString()}`,
      `Minimum Allocation: ${formatAmount(dropInfo.minimumAllocation)}`,
      ``,
      `Filtered Out:`,
      `  - Count: ${dropInfo.filteredStats.count.toLocaleString()}`,
      `  - Amount: ${formatAmount(dropInfo.filteredStats.amount)} tokens`,
    ].join("\n");

    const filename = `drop_${sanitizeFilename(dropInfo.slug)}_${dropInfo.dropId}_${sanitizeFilename(dropInfo.database)}.csv`;

    await bot.sendDocument(
      chatId,
      buffer,
      {
        caption,
      },
      {
        filename,
        contentType: "text/csv",
      },
    );

    console.log(`Successfully uploaded CSV to Telegram: ${filename}`);
  } catch (error) {
    console.error("Failed to upload CSV to Telegram:", error);
    // Don't throw - we don't want to fail the entire job if Telegram upload fails
  }
}
