import { Account, RpcProvider } from "starknet";
import initializeClient from "./initializeClient.js";

const dropId = process.env.DROP_ID;

if (!dropId) throw new Error("Missing drop ID");
const client = await initializeClient();
const { rows } = await client.query<{ root: string }>({
  text: `SELECT root
         FROM generated_drop
         WHERE id = $1
           AND id NOT IN (SELECT drop_id FROM deployed_airdrop_contracts)`,
  values: [BigInt(dropId)],
});
if (rows.length !== 1) {
  throw new Error(`Drop ID ${dropId} not found or already deployed`);
}
const root = BigInt(rows[0].root);

const distributedToken = BigInt(process.env.DISTRIBUTED_TOKEN);
const accountAddress = process.env.ACCOUNT_ADDRESS;
const privateKey = process.env.PRIVATE_KEY;
const provider = new RpcProvider({ nodeUrl: process.env.NODE_URL });

const deployerAccount = new Account(provider, accountAddress, privateKey);

const airdropClassHash =
  "0x01cb5e128a81be492ee7b78cf4ba4849cb35f311508e13a558755f4549839f14";

const constructorCalldata = [distributedToken, root, "0x0", "0x0"];
console.log(
  `Deploying airdrop with class hash ${airdropClassHash} and arguments`,
  constructorCalldata
);

const deployResponse = await deployerAccount.deployContract({
  classHash: airdropClassHash,
  constructorCalldata,
});

await provider.waitForTransaction(deployResponse.transaction_hash);

console.log("Deployed airdrop", deployResponse.contract_address);

await client.query({
  text: `
      INSERT INTO deployed_airdrop_contracts (address, token, drop_id)
      VALUES ($1, $2, $3);
  `,
  values: [
    BigInt(deployResponse.contract_address),
    distributedToken,
    BigInt(dropId),
  ],
});

console.log("Inserted airdrop row");
