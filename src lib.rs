describe("guardian", () => {
const payer = pg.wallet.keypair;
const owner = web3.Keypair.generate();
const agent = web3.Keypair.generate();
const impostor = web3.Keypair.generate();
const friend = web3.Keypair.generate();
const stranger = web3.Keypair.generate();
const sys = web3.SystemProgram.programId;
const C = { commitment: "confirmed" };
const [policy] = web3.PublicKey.findProgramAddressSync(
[Buffer.from("policy"), owner.publicKey.toBuffer()],
pg.PROGRAM_ID
);
const [vault] = web3.PublicKey.findProgramAddressSync(
[Buffer.from("vault"), policy.toBuffer()],
pg.PROGRAM_ID
);
const sol = (n) => new BN(Math.round(n * web3.LAMPORTS_PER_SOL));
async function expectFail(p, needle) {
try {
await p;
} catch (e) {
const text = String(e) + JSON.stringify(e.logs || "");
assert(text.includes(needle), "wanted " + needle + " but got: " + text.slice(0, 300));
return;
}
assert.fail("expected " + needle + " but it succeeded");
}
const transfer = (to, amount, signer = agent) =>
pg.program.methods
.agentTransfer(sol(amount))
.accounts({ agent: signer.publicKey, policy, vault, recipient: to, systemProgram: sys })
.signers([signer])
.rpc(C);
const setPolicy = (limit, paused) =>
pg.program.methods
.updatePolicy(agent.publicKey, sol(limit), [friend.publicKey], paused)
.accounts({ owner: owner.publicKey, policy })
.signers([owner])
.rpc(C);
it("funds a fresh owner", async () => {
const tx = new web3.Transaction().add(
web3.SystemProgram.transfer({
fromPubkey: payer.publicKey,
toPubkey: owner.publicKey,
lamports: 0.2 * web3.LAMPORTS_PER_SOL,
})
);
await web3.sendAndConfirmTransaction(pg.connection, tx, [payer], C);
});
it("creates the policy", async () => {
await pg.program.methods
.initialize(agent.publicKey, sol(0.5), [friend.publicKey])
.accounts({ owner: owner.publicKey, policy, vault, systemProgram: sys })
.signers([owner])
.rpc(C);
const p = await pg.program.account.policy.fetch(policy, "confirmed");
assert(p.agent.equals(agent.publicKey));
assert(p.dailyLimit.eq(sol(0.5)));
assert.equal(p.allowed.length, 1);
});
it("owner funds the vault", async () => {
await pg.program.methods
.deposit(sol(0.1))
.accounts({ owner: owner.publicKey, policy, vault, systemProgram: sys })
.signers([owner])
.rpc(C);
assert.equal(await pg.connection.getBalance(vault, "confirmed"), sol(0.1).toNumber());
});
it("agent pays an allowed address inside the limit", async () => {
await transfer(friend.publicKey, 0.02);
assert.equal(await pg.connection.getBalance(friend.publicKey, "confirmed"), sol(0.02).toNumber());
});
it("agent cannot pay an address that is not allowed", async () => {
await expectFail(transfer(stranger.publicKey, 0.01), "RecipientNotAllowed");
});
it("someone who is not the agent cannot move funds", async () => {
await expectFail(transfer(friend.publicKey, 0.01, impostor), "NotAgent");
});
it("agent cannot pass the daily limit", async () => {
await setPolicy(0.03, false);
await expectFail(transfer(friend.publicKey, 0.02), "DailyLimitExceeded");
await transfer(friend.publicKey, 0.01);
});
it("pausing blocks the agent", async () => {
await setPolicy(0.5, true);
await expectFail(transfer(friend.publicKey, 0.001), "Paused");
});
});
