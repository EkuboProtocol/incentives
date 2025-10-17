import TelegramBot from "node-telegram-bot-api";
import { Allocation } from "./airdrop.js";

export interface DropInfo {
  slug: string;
  dropId: number;
  periodIds: string[];
  firstStartTime: Date;
  lastEndTime: Date;
  minimumAllocation: bigint;
  filteredStats: { amount: bigint; count: number };
  database: string;
  networkType: string;
}

/**
 * Generates a CSV string from allocations
 */
export function generateCsv(allocations: Allocation[]): string {
  const header = "address,amount,amount_formatted\n";
  const rows = allocations
    .map(
      ({ address, amount }) =>
        `${address.toString()},${amount.toString()},${Number(amount) / 1e18}`,
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
    const bot = new TelegramBot(botToken);

    const csv = generateCsv(allocations);
    const buffer = Buffer.from(csv, "utf-8");

    const sum = allocations.reduce((memo, { amount }) => memo + amount, 0n);
    const formattedSum = Number(sum) / 1e18;

    const caption = [
      `📊 **Drop Generated**`,
      ``,
      `**Campaign:** ${dropInfo.slug}`,
      `**Database:** ${dropInfo.database}`,
      `**Network:** ${dropInfo.networkType}`,
      `**Drop ID:** ${dropInfo.dropId}`,
      `**Periods:** ${dropInfo.periodIds.join(", ")}`,
      `**Period Range:** ${dropInfo.firstStartTime.toISOString()} to ${dropInfo.lastEndTime.toISOString()}`,
      ``,
      `**Total Amount:** ${formattedSum.toLocaleString()} tokens`,
      `**Recipients:** ${allocations.length.toLocaleString()}`,
      `**Minimum Allocation:** ${Number(dropInfo.minimumAllocation) / 1e18}`,
      ``,
      `**Filtered Out:**`,
      `  - Count: ${dropInfo.filteredStats.count.toLocaleString()}`,
      `  - Amount: ${(Number(dropInfo.filteredStats.amount) / 1e18).toLocaleString()} tokens`,
    ].join("\n");

    const filename = `drop_${dropInfo.slug}_${dropInfo.dropId}_${dropInfo.database}.csv`;

    await bot.sendDocument(
      chatId,
      buffer,
      {
        caption,
        parse_mode: "Markdown",
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
