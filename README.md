# Guardian

**A spending firewall for AI agents on Solana.** Your agent gets its own key, but a Solana program decides what that key can actually do. Even a tricked agent can't empty your vault.

Built for the Dev3pack Global Hackathon, combining two ideas from Solana's Request for Startups: an AI financial advisor in your wallet and security for the agentic age.

- **Live demo:** https://amaylvia-gitseries.github.io/guardian-wallet/ (no wallet needed, runs on devnet)
- **Program (devnet):** [`FWJTeHoNHWBCmKepVsNDS5MnLh891BfsK2HyLAJBj9sY`](https://explorer.solana.com/address/FWJTeHoNHWBCmKepVsNDS5MnLh891BfsK2HyLAJBj9sY?cluster=devnet)

## The problem

People want AI agents that can pay for things, but today it's all or nothing: hand over the whole wallet, or approve every payment by hand. A single poisoned memo or web page can talk an agent into sending everything it can reach, and safety checks that live in the same app as the agent can be fooled by the same trick.

## How it works

You keep a vault that holds your SOL. The agent gets its own key, but that key can only call one instruction, `agent_transfer`. The program checks every call against three rules:

1. **Not paused.** The owner can freeze the agent instantly.
2. **Recipient on the allowlist.** The agent can only pay addresses the owner approved.
3. **Rolling 24-hour limit.** The agent can't spend more than the daily limit.

If any rule fails, the transaction fails and no money moves. Only the owner key can change the rules, deposit or withdraw. Because the rules live in the program and not in the app, they hold even if the agent is fully compromised.

## What's in the demo

- **Copilot.** Ask the agent to send SOL in plain English. Guardian explains the payment and checks it against your rules, then you can send it. For blocked payments there is a "Try on-chain anyway" button, so you can watch the program itself reject it, with a link to the failed transaction on the explorer.
- **Rules editor.** Change the daily limit, add or remove allowed addresses, pause the agent, top up the vault. Each change is a real transaction.
- **Activity feed.** Every approved and rejected attempt, with explorer links.
- **Transaction inspector.** Paste any serialized Solana transaction and get a plain-English explanation plus flags for drains, unlimited token approvals, ownership changes, unknown programs, durable nonces and prompt-injection text in memos.
- **Isolated sandboxes.** Every visitor is assigned one of 12 separate policies and vaults on devnet, so judges and testers don't break each other's demo. The Switch button moves you to another one.

## Program

Anchor (Rust), deployed to Solana devnet.

| Account | Seeds | Purpose |
| --- | --- | --- |
| Policy | `["policy", owner]` | Agent key, daily limit, amount spent, window start, paused flag, allowlist (up to 8) |
| Vault | `["vault", policy]` | System account that holds the SOL. Only the program can sign for it |

| Instruction | Who can call it | What it does |
| --- | --- | --- |
| `initialize(agent, daily_limit, allowed)` | Owner | Creates the policy and the vault |
| `deposit(amount)` | Owner | Moves SOL from the owner into the vault |
| `withdraw(amount)` | Owner | Moves SOL back to the owner, even while paused |
| `update_policy(agent, daily_limit, allowed, paused)` | Owner | Changes the agent, limit, allowlist or paused flag |
| `agent_transfer(amount)` | Agent only | Pays an allowlisted recipient if all three rules pass |

Errors: `Paused`, `RecipientNotAllowed`, `DailyLimitExceeded`, `NotAgent`, `TooManyAllowed`, `MathOverflow`.

## Repo layout

| Path | What it is |
| --- | --- |
| `src/lib.rs` | The Anchor program |
| `tests/anchor.test.ts` | Program tests for Solana Playground (8 passing on devnet) |
| `index.html` | Landing page |
| `app.html` | The demo app (single file, uses `@solana/web3.js` from a CDN) |
| `guardian-core.js` | Risk engine behind the transaction inspector. No dependencies |
| `guardian-core.test.js` | 29 unit tests for the engine |
| `setup-sandboxes.js` | Playground script that creates the 12 demo sandboxes |

## Run it yourself

No local setup needed. Everything works from a phone or browser.

1. Open https://beta.solpg.io and create a new Anchor project.
2. Paste `src/lib.rs` into `src/lib.rs`. Press **Build**, switch to **Devnet**, get devnet SOL from https://faucet.solana.com, then **Deploy**. Playground gives you your own program ID.
3. Paste `tests/anchor.test.ts` into `tests/` and press **Test**.
4. To run the demo app against your own deployment: replace the program ID in `app.html`, paste `setup-sandboxes.js` into `client.ts` in Playground and press **Run** (it spends under 1 devnet SOL), then host the repo with GitHub Pages.

Note: the vault is a system account and must stay rent-exempt (about 0.00089 SOL), so deposit at least 0.01 SOL before the agent sends anything.

## Tests

- Program: 8 passing tests on devnet, covering the policy, deposit, an allowed payment, and each rule's failure case (not allowlisted, not the agent, over the limit, paused).
- Engine: `npm i @solana/web3.js @solana/spl-token` then `node --test guardian-core.test.js` (29 tests).

## Honest notes

- This is a devnet prototype and has not been audited. Don't use real funds.
- The demo's owner, agent and sandbox keys are derived from public phrases on purpose, so anyone can try it without a wallet. That's safe to demonstrate because the program, not the key, is what limits the agent: even with the agent key public, it can only pay allowlisted addresses up to the daily limit. A real deployment would have the owner sign with their own wallet.
- The chat understands simple sentences using rules, not a language model. The checks and the rejections are real and come from the on-chain program, and the agent logic is easy to swap for an LLM.
- The policy covers SOL only. SPL tokens are not covered by the limit yet.
- The activity feed is kept in your browser, per sandbox.

## Roadmap

- LLM intent layer so the agent can understand free-form requests
- SPL token support in the policy
- Wallet connection so the owner signs with their own wallet
- Per-recipient limits and time-locked allowlist changes

## License

MIT
