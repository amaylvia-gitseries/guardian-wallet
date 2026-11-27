const N = 12;
const C = { commitment: "confirmed" };
const L = web3.LAMPORTS_PER_SOL;
const sys = web3.SystemProgram.programId;
const sol = (n) => new BN(Math.round(n * L));
const kp = (s) => {
const b = new Uint8Array(32);
b.set(new TextEncoder().encode(s));
return web3.Keypair.fromSeed(b);
};
const payer = pg.wallet.keypair;
const friend = kp("guardian-demo-friend-devnet");
const bal = (k) => pg.connection.getBalance(k, "confirmed");
async function again(fn) {
for (let i = 0; i < 3; i++) {
try {
return await fn();
} catch (e) {
if (i === 2) throw e;
}
}
}
async function give(to, sols) {
const tx = new web3.Transaction().add(
web3.SystemProgram.transfer({
fromPubkey: payer.publicKey,
toPubkey: to,
lamports: Math.round(sols * L),
})
);
await web3.sendAndConfirmTransaction(pg.connection, tx, [payer], C);
}
console.log("Setting up " + N + " sandboxes. This takes a few minutes, keep this tab open.");
for (let i = 1; i <= N; i++) {
const owner = kp("guardian-sbx-owner-" + i);
const agent = kp("guardian-sbx-agent-" + i);
const [policy] = web3.PublicKey.findProgramAddressSync(
[Buffer.from("policy"), owner.publicKey.toBuffer()],
pg.PROGRAM_ID
);
const [vault] = web3.PublicKey.findProgramAddressSync(
[Buffer.from("vault"), policy.toBuffer()],
pg.PROGRAM_ID
);
let exists = true;
try {
await pg.program.account.policy.fetch(policy, "confirmed");
} catch (e) {
exists = false;
}
if (!exists) {
if ((await bal(owner.publicKey)) < 0.06 * L) {
await again(() => give(owner.publicKey, 0.07));
}
await again(() =>
pg.program.methods
.initialize(agent.publicKey, sol(0.02), [friend.publicKey])
.accounts({ owner: owner.publicKey, policy, vault, systemProgram: sys })
.signers([owner])
.rpc(C)
);
}
if ((await bal(agent.publicKey)) < 0.002 * L) {
await again(() => give(agent.publicKey, 0.005));
}
if ((await bal(vault)) < 0.03 * L) {
if ((await bal(owner.publicKey)) < 0.045 * L) {
await again(() => give(owner.publicKey, 0.05));
}
await again(() =>
pg.program.methods
.deposit(sol(0.04))
.accounts({ owner: owner.publicKey, policy, vault, systemProgram: sys })
.signers([owner])
.rpc(C)
);
}
console.log("sandbox " + i + " of " + N + " ready, vault " + (await bal(vault)) / L + " SOL");
}
console.log("All sandboxes are ready.");
console.log("Your wallet now has " + (await bal(payer.publicKey)) / L + " SOL");
