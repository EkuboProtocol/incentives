import { Account, RpcProvider } from "starknet";
import postgres from "postgres";
import {
  DEPLOY_DETAILS,
  getNodeUrls,
  withEndpointFailover,
  withRpcRetry,
} from "./util/rpcRetry.js";
import { generateAndInsertClaimsDrop } from "./util/generateAndInsertDrop.js";
import { Claim } from "./util/airdrop.js";
import { NUMERIC_INTEGER_TYPE } from "./util/postgres.js";
import { STARKNET_AIRDROP_CONTRACT_OPTIONS } from "./util/starknetAirdropContract.js";

const DEFAULT_CHAIN_ID = 23448594291968334n;
const DEFAULT_AIRDROP_CLASS_HASH =
  "0x01cb5e128a81be492ee7b78cf4ba4849cb35f311508e13a558755f4549839f14";

interface ClaimRow {
  id: number;
  claimee: bigint;
  amount: bigint;
  delegate_portion: bigint;
  staker_portion: bigint;
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

function parseEnvBigInt(name: string, defaultValue?: bigint): bigint {
  const value = process.env[name];
  if (!value) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`${name} must be set`);
  }
  try {
    return BigInt(value);
  } catch {
    throw new Error(`${name} must be a bigint-compatible string`);
  }
}

function parseEnvInteger(name: string): bigint {
  const value = getRequiredEnv(name);
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`${name} must be an integer`);
  }
  try {
    return BigInt(value);
  } catch {
    throw new Error(`${name} must be an integer`);
  }
}

const startDate = getRequiredEnv("START_DATE");
const endDate = getRequiredEnv("END_DATE");
const amount = getRequiredEnv("AMOUNT");
const stakerShare = parseEnvInteger("STAKER_SHARE");
const delegateShare = parseEnvInteger("DELEGATE_SHARE");
const rewardToken = parseEnvBigInt("REWARD_TOKEN");
const chainId = parseEnvBigInt("CHAIN_ID", DEFAULT_CHAIN_ID);
const airdropClassHash =
  process.env.AIRDROP_CLASS_HASH ?? DEFAULT_AIRDROP_CLASS_HASH;
const accountAddress = process.env.ACCOUNT_ADDRESS;
const privateKey = process.env.PRIVATE_KEY;

if (stakerShare < 0n || delegateShare < 0n) {
  throw new Error("STAKER_SHARE and DELEGATE_SHARE must be non-negative");
}

if (!accountAddress || !privateKey) {
  throw new Error("Missing ACCOUNT_ADDRESS or PRIVATE_KEY");
}

const sql = postgres({
  ssl: "prefer",
  types: {
    bigint: postgres.BigInt,
    numeric: NUMERIC_INTEGER_TYPE,
  },
});

// Ordered RPC endpoints (primary first, public fallback last). Query the
// latest block instead of starknet.js's default (pending): nodes answer
// pending-block reads such as starknet_getNonce with `-32001: Unable to
// complete request at this time` far more often.
const nodeUrls = getNodeUrls();

function createDeployer(nodeUrl: string): {
  provider: RpcProvider;
  account: Account;
} {
  const provider = new RpcProvider({ nodeUrl, blockIdentifier: "latest" });
  return {
    provider,
    account: new Account({
      provider,
      address: accountAddress,
      signer: privateKey,
      // The deployer is a Cairo 1 OZ account; skip version auto-detection
      // (extra getClassAt calls) on quota-limited endpoints.
      cairoVersion: "1",
    }),
  };
}

try {
  const rewards = await sql<ClaimRow[]>`
      SELECT id,
             claimee,
             amount,
             delegate_portion,
             staker_portion
      FROM calculate_staker_rewards(
        ${startDate}::timestamptz,
        ${endDate}::timestamptz,
        ${amount}::numeric,
        ${stakerShare},
        ${delegateShare}
      )
      ORDER BY id
  `;

  if (rewards.length === 0) {
    throw new Error("calculate_staker_rewards returned no rows");
  }

  const totalAmount = rewards.reduce((memo, row) => memo + row.amount, 0n);
  const totalStakerPortion = rewards.reduce(
    (memo, row) => memo + row.staker_portion,
    0n,
  );
  const totalDelegatePortion = rewards.reduce(
    (memo, row) => memo + row.delegate_portion,
    0n,
  );

  const claims: Claim[] = rewards.map(({ id, claimee, amount }) => ({
    id,
    address: claimee,
    amount,
  }));

  const dropId = await generateAndInsertClaimsDrop(
    sql,
    claims,
    [],
    STARKNET_AIRDROP_CONTRACT_OPTIONS,
  );

  const [{ root }] = await sql<{ root: string }[]>`
      SELECT root::text
      FROM incentives.generated_drop
      WHERE id = ${dropId}
  `;

  const constructorCalldata = [rewardToken.toString(), root, "0x0", "0x0"];

  console.log(`Found ${rewards.length} recipient(s)`);
  console.log(`Total amount: ${totalAmount}`);
  console.log(`Staker portion total: ${totalStakerPortion}`);
  console.log(`Delegate portion total: ${totalDelegatePortion}`);
  console.log(`Merkle root: ${root}`);
  console.log(`Deploying class hash ${airdropClassHash}`);

  console.log(`Created generated drop ${dropId}`);

  // Broadcast and confirmation use separate failover passes so that a
  // failing confirmation poll retries the wait instead of deploying a
  // duplicate contract.
  const deployResponse = await withEndpointFailover(nodeUrls, (url) => {
    const { account } = createDeployer(url);
    return withRpcRetry(() =>
      account.deployContract(
        {
          classHash: airdropClassHash,
          constructorCalldata,
        },
        DEPLOY_DETAILS,
      ),
    );
  });
  await withEndpointFailover(nodeUrls, (url) => {
    const { provider } = createDeployer(url);
    return withRpcRetry(() =>
      provider.waitForTransaction(deployResponse.transaction_hash, {
        retryInterval: DEPLOY_DETAILS.retryInterval,
      }),
    );
  });

  console.log(
    `Submitted deployment tx ${deployResponse.transaction_hash} for drop ${dropId}`,
  );

  await sql`
      INSERT INTO incentives.deployed_airdrop_contracts (chain_id, address, token, drop_id)
      VALUES (
        ${chainId.toString()},
        ${BigInt(deployResponse.contract_address).toString()},
        ${rewardToken.toString()},
        ${dropId}
      )
  `;

  console.log(`Deployed contract: ${deployResponse.contract_address}`);
  console.log(`Stored deployed_airdrop_contracts row for drop ${dropId}`);
} finally {
  await sql.end({ timeout: 5 });
}
