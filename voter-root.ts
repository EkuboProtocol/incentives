import { Allocation } from "./airdrop.js";
import { generateDrop } from "./generate-drop.js";
import initializeIncentivesClient from "./initializeIncentivesClient.js";

const proposalId = BigInt(process.env.PROPOSAL_ID);
const totalReward = BigInt(process.env.TOTAL_REWARD);
const PROPOSAL_VOTING_DELAY = 86400;
const PROPOSAL_VOTING_PERIOD = 86400 * 7;

const client = await initializeIncentivesClient();

await client.query("BEGIN;");

const { rows: proposalTimeQuery } = await client.query<{ time: Date }>({
  text: `
        SELECT time
        FROM governor_proposed gp
                 JOIN event_keys ek ON gp.event_id = ek.id
                 JOIN blocks b ON ek.block_number = b.number
        WHERE gp.id = $1
    `,
  values: [proposalId],
});

const { rows: votes } = await client.query<{
  delegator: string;
  votes_contributed: string;
}>({
  values: [proposalId],
  text: `
        WITH proposal_time AS (SELECT time AS proposal_created, (time + INTERVAL '1 days') AS proposal_voting_starts
                               FROM governor_proposed gp
                                        JOIN event_keys ek ON gp.event_id = ek.id
                                        JOIN blocks b ON ek.block_number = b.number
                               WHERE gp.id = $1),
             all_stake_events AS (SELECT b.time          AS delta_time,
                                         ss.from_address AS delegator,
                                         ss.delegate     AS delegate,
                                         ss.amount       AS delta
                                  FROM staker_staked ss
                                           JOIN event_keys ek ON ss.event_id = ek.id
                                           JOIN blocks b ON ek.block_number = b.number
                                  UNION ALL
                                  SELECT b.time          AS delta_time,
                                         sw.from_address AS delegator,
                                         sw.delegate     AS delegate,
                                         -sw.amount      AS delta
                                  FROM staker_withdrawn sw
                                           JOIN event_keys ek ON sw.event_id = ek.id
                                           JOIN blocks b ON ek.block_number = b.number),
             delegation_events AS (SELECT delegator,
                                          delegate,
                                          GREATEST(0, EXTRACT(EPOCH FROM
                                                              (pt.proposal_voting_starts -
                                                               GREATEST(ase.delta_time, pt.proposal_created)))) AS num_seconds,
                                          delta
                                   FROM all_stake_events ase,
                                        proposal_time pt),
             voting_weights AS (SELECT delegator,
                                       delegate,
                                       FLOOR(SUM(num_seconds * delta) / 86400) AS voting_weight
                                FROM delegation_events
                                WHERE num_seconds != 0
                                GROUP BY delegator, delegate)
        SELECT vw.delegator     AS delegator,
               vw.voting_weight AS votes_contributed
        FROM voting_weights vw
        WHERE
          -- exclude Ekubo, Inc. as a delegator
            delegator NOT IN (0x07be094d936b49bd8b41e62e27958f2ee9f65379db88e2bbd8cbbbdb2799acb0)
          -- the selected delegate must have voted in the proposal
          AND delegate IN (SELECT voter FROM governor_voted gv WHERE gv.id = $1)
          AND vw.voting_weight > 0
        ORDER BY voting_weight DESC
    `,
});
await client.query("COMMIT;");

if (proposalTimeQuery.length !== 1) {
  throw new Error("Proposal not found");
}

const totalVotes = votes.reduce(
  (memo, { votes_contributed }) => memo + BigInt(votes_contributed),
  0n,
);

const amounts: Allocation[] = votes
  .map(({ delegator, votes_contributed }) => ({
    owner: BigInt(delegator),
    total: (BigInt(votes_contributed) * totalReward) / totalVotes,
  }))
  .map(({ total, owner }) => ({ claimee: owner, amount: total }));

const startDate = new Date(
  proposalTimeQuery[0].time.getTime() + PROPOSAL_VOTING_DELAY * 1000,
);
const endDate = new Date(startDate.getTime() + PROPOSAL_VOTING_PERIOD * 1000);
const dropId = await generateDrop(client, amounts, startDate, endDate);

console.log("Created drop ID", dropId);

await client.end();
