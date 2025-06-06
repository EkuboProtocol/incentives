import initializeIncentivesClient from "./util/initializeIncentivesClient.js";
import {
  checksumAddress,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbi,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { INCENTIVES_ABI } from "./util/incentivesAbi.js";
import { mainnet, sepolia } from "viem/chains";

const owner = checksumAddress(toHex(BigInt(process.env.OWNER), { size: 20 }));

const incentivesAddress = checksumAddress(
  toHex(BigInt(process.env.INCENTIVES_ADDRESS), { size: 20 }),
);

const account = privateKeyToAccount(
  toHex(BigInt(process.env.PRIVATE_KEY), { size: 32 }),
);

const rpcUrl = process.env.RPC_URL;
if (!rpcUrl) throw new Error("Missing RPC_URL");

const chains = [
  { id: 1, config: mainnet },
  { id: 11155111, config: sepolia },
];
const chainIndex = chains.findIndex(
  (c) => c.id === Number(process.env.CHAIN_ID),
);
if (chainIndex === -1) {
  throw new Error("Unsupported CHAIN ID");
}

const chain = chains[chainIndex].config;

const walletClient = createWalletClient({
  transport: http(rpcUrl),
  chain,
  account,
});
const publicClient = createPublicClient({
  transport: http(rpcUrl),
  chain,
});

const chainId = await walletClient.getChainId();

console.log(`Funding drops for chain ID ${chainId}`);

const client = await initializeIncentivesClient();

try {
  const { rows } = await client.query<{
    root: string;
    reward_token: string;
    total_amount: string;
  }>({
    text: `
            WITH drop_amounts AS
                     (SELECT drop_id,
                             SUM(amount) AS total
                      FROM incentives.generated_drop_proof
                      GROUP BY drop_id),
                 drop_tokens AS
                     (SELECT drop_id, ARRAY_AGG(DISTINCT c.reward_token) AS reward_tokens
                      FROM incentives.generated_drop_reward_periods gdrp
                               JOIN incentives.campaign_reward_periods crp ON gdrp.campaign_reward_period_id = crp.id
                               JOIN incentives.campaigns c ON crp.campaign_id = c.id
                      GROUP BY gdrp.drop_id)
            SELECT gd.root             AS root,
                   dt.reward_tokens[1] AS reward_token,
                   da.total            AS total_amount
            FROM incentives.generated_drop gd
                     JOIN drop_amounts da ON gd.id = da.drop_id
                     JOIN drop_tokens dt ON gd.id = dt.drop_id
            WHERE ARRAY_LENGTH(dt.reward_tokens, 1) = 1
              AND gd.root NOT IN (SELECT root FROM incentives_funded)
        `,
  });

  if (rows.length === 0) {
    console.log("No drops to fund");
  } else {
    const totalFundsByToken = rows.reduce<{
      [rewardToken: `0x${string}`]: bigint;
    }>((memo, row) => {
      const token = checksumAddress(
        toHex(BigInt(row.reward_token), { size: 20 }),
      );
      memo[token] = (memo[token] ?? 0n) + BigInt(row.total_amount);
      return memo;
    }, {});

    const APPROVE_ABI = parseAbi([
      "function approve(address spender, uint256 amount) external",
    ]);

    for (const [token, amount] of Object.entries(totalFundsByToken)) {
      const transactionHash = await walletClient.writeContract({
        account,
        chain,
        abi: APPROVE_ABI,
        address: token as `0x${string}`,
        functionName: "approve",
        args: [incentivesAddress, amount],
      });

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: transactionHash,
      });
      if (receipt.status === "success") {
        console.log(
          `Approved ${incentivesAddress} to spend ${amount} of token ${token} in transaction ${transactionHash}`,
        );
      } else {
        throw new Error(`Approval tx ${transactionHash} failed`);
      }
    }

    const fundTransactionHash = await walletClient.writeContract({
      account,
      chain,

      abi: INCENTIVES_ABI,
      address: incentivesAddress,
      functionName: "multicall",
      args: [
        rows.map((row) =>
          encodeFunctionData({
            abi: INCENTIVES_ABI,
            functionName: "fund",
            args: [
              {
                owner: owner,
                root: toHex(BigInt(row.root), { size: 32 }),
                token: checksumAddress(
                  toHex(BigInt(row.reward_token), { size: 20 }),
                ),
              },
              BigInt(row.total_amount),
            ],
          }),
        ),
      ],
    });

    console.log(
      `Funded in transaction hash ${fundTransactionHash}: https://etherscan.io/tx/${fundTransactionHash}`,
    );
  }
} finally {
  await client.end();
}
