# Guardian Wallet

An AI wallet copilot with a firewall that lives on-chain.

An AI agent can propose payments for you, but it can never move your money outside the rules you set. Those rules are enforced by a Solana program, not by the app. So even a hacked, confused or prompt-injected agent cannot get past them.

Built for the Dev3pack Global Hackathon. It combines two ideas from Solana's Request for Startups: an AI financial advisor in your wallet (#8) and security for the agentic age (#4).

## The problem

Giving an AI agent access to a wallet is risky. If the agent is tricked, it can drain everything it can reach. Checking transactions in the app is not enough, because the app is the part that can be fooled.

## How it works

You keep a vault that holds your SOL. The agent gets its own key, but that key can only call one instruction, `agent_transfer`. Every call is checked on-chain against three rules:

1. **Not paused.** The owner can freeze the agent instantly.
2. **Recipient on the allowlist.** The agent can only pay addresses the owner has approved.
3. **Rolling 24-hour limit.** The agent cannot spend more than the daily limit. The window resets 24 hours after it starts.

If any rule fails, the transaction fails. The owner can always deposit, withdraw, change the rules or pause, and nobody else can.

## Program

- Framework: Anchor (Rust)
- Network: Solana devnet
- Program ID: FWJTeHoNHWBCmKepVsNDS5MnLh891BfsK2HyLAJBj9sY
- Explorer: https://explorer.solana.com/address/PASTE_FULL_PROGRAM_ID?cluster=devnet

### Accounts

| Account | Seeds | Purpose |
| --- | --- | --- |
| Policy | `["policy", owner]` | Stores the agent key, daily limit, amount spent, window start, paused flag and allowlist (up to 8 addresses) |
| Vault | `["vault", policy]` | System account that holds the SOL. Only the program can sign for it |

### Instructions

| Instruction | Who can call it | What it does |
| --- | --- | --- |
| `initialize(agent, daily_limit, allowed)` | Owner | Creates the policy and the vault |
| `deposit(amount)` | Owner | Moves SOL from the owner into the vault |
| `withdraw(amount)` | Owner | Moves SOL from the vault back to the owner, even while paused |
| `update_policy(agent, daily_limit, allowed, paused)` | Owner | Changes the agent, limit, allowlist or paused flag |
| `agent_transfer(amount)` | Agent only | Pays an allowlisted recipient, if all three rules pass |

### Errors

`Paused`, `RecipientNotAllowed`, `DailyLimitExceeded`, `NotAgent`, `TooManyAllowed`, `MathOverflow`

## Run it yourself

No local setup needed. Everything works from a browser with Solana Playground.

1. Open https://beta.solpg.io and create a new Anchor project.
2. Paste `src/lib.rs` from this repo into `src/lib.rs` in Playground.
3. Press **Build**, switch to **Devnet**, get devnet SOL from https://faucet.solana.com, then press **Deploy**.
4. Paste `tests/anchor.test.ts` from this repo into the `tests` folder in Playground and press **Test**.

Playground replaces the program ID with your own when you build, so your deployment will have a different address from the one above.

Note: the vault is a system account and must stay rent-exempt (about 0.00089 SOL), so deposit at least 0.01 SOL before the agent sends anything.

## Tests

The test file runs against the deployed devnet program, using a fresh owner each run. It currently has 8 passing tests:

- Creates the policy
- Owner funds the vault
- Agent pays an allowed address inside the limit
- Agent cannot pay an address that is not allowed
- Someone who is not the agent cannot move funds
- Agent cannot pass the daily limit
- Pausing blocks the agent

## Status and roadmap

Working and deployed to devnet:

- The spending-policy program with all three on-chain checks
- Tests covering each rule, including the failure cases

Next:

- A front end where the AI copilot proposes a transaction, explains it in plain English and flags risks (unlimited token approvals, ownership changes, unknown programs) before it reaches your signature
- Calling `agent_transfer` from the app so the on-chain rejection shows up in the demo
- SPL token support in the policy

## License

MIT
