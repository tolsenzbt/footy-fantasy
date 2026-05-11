import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { getDraftState } from "../src/lib/draft/state";
import { client } from "../src/db";

const leagueId = process.argv[2];
if (!leagueId) {
  console.error("usage: tsx scripts/check-draft-state.ts <leagueId>");
  process.exit(1);
}

async function main() {
  const state = await getDraftState(leagueId, "initial");
  console.log(JSON.stringify(state, null, 2));
}

main()
  .then(async () => { await client.end(); process.exit(0); })
  .catch(async (err) => { console.error(err); await client.end(); process.exit(1); });
