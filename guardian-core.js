// Guardian core: decides whether a Solana transaction is safe to sign, and says why in plain English.
// Pure JS, no dependencies. Works in Node (require) and in the browser (window.Guardian).
//
// Main entry points
//   Guardian.analyze(tx, ctx)        -> { verdict, score, findings, lines, ... }
//   Guardian.scanText(text)          -> findings for prompt-injection / hidden-character tricks
//   Guardian.analyzeMint(parsed)     -> findings for a token mint (freeze authority, Token-2022 extensions)
//   Guardian.analyzeSimulation(sim)  -> findings from a simulateTransaction result
//   Guardian.parseIntent(text)       -> turns a chat message into a structured intent
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Guardian = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- base58 (so the core needs no libraries) ----------
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  function b58encode(bytes) {
    const digits = [];
    for (let i = 0; i < bytes.length; i++) {
      let carry = bytes[i];
      for (let j = 0; j < digits.length; j++) {
        carry += digits[j] << 8;
        digits[j] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry > 0) {
        digits.push(carry % 58);
        carry = (carry / 58) | 0;
      }
    }
    let out = '';
    for (let k = 0; k < bytes.length && bytes[k] === 0; k++) out += '1';
    for (let q = digits.length - 1; q >= 0; q--) out += ALPHABET[digits[q]];
    return out;
  }

  function b58decode(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      const v = ALPHABET.indexOf(str[i]);
      if (v < 0) throw new Error('Not a base58 string');
      let carry = v;
      for (let j = 0; j < bytes.length; j++) {
        carry += bytes[j] * 58;
        bytes[j] = carry & 0xff;
        carry >>= 8;
      }
      while (carry > 0) {
        bytes.push(carry & 0xff);
        carry >>= 8;
      }
    }
    for (let k = 0; k < str.length && str[k] === '1'; k++) bytes.push(0);
    return Uint8Array.from(bytes.reverse());
  }

  function isValidAddress(s) {
    if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
    try {
      return b58decode(s).length === 32;
    } catch (e) {
      return false;
    }
  }

  // ---------- constants ----------
  const PROGRAMS = {
    SYSTEM: '11111111111111111111111111111111',
    TOKEN: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    TOKEN_2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    ATA: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    MEMO: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
    MEMO_V1: 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
    COMPUTE_BUDGET: 'ComputeBudget111111111111111111111111111111',
    JUPITER_V6: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  };

  const KNOWN_NAMES = {
    [PROGRAMS.SYSTEM]: 'System Program',
    [PROGRAMS.TOKEN]: 'SPL Token',
    [PROGRAMS.TOKEN_2022]: 'Token-2022',
    [PROGRAMS.ATA]: 'Associated Token Account',
    [PROGRAMS.MEMO]: 'Memo',
    [PROGRAMS.MEMO_V1]: 'Memo',
    [PROGRAMS.COMPUTE_BUDGET]: 'Compute Budget',
    [PROGRAMS.JUPITER_V6]: 'Jupiter',
  };

  const U64_MAX = (1n << 64n) - 1n;
  const LAMPORTS_PER_SOL = 1000000000n;

  // ---------- small helpers ----------
  const short = (a) => (a && a.length > 12 ? a.slice(0, 4) + '…' + a.slice(-4) : String(a));

  function sol(lamports) {
    const l = BigInt(lamports);
    const whole = l / LAMPORTS_PER_SOL;
    const frac = (l % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '');
    return frac ? whole + '.' + frac : whole.toString();
  }

  function solToLamports(str) {
    const s = String(str).trim();
    if (!/^\d+(\.\d{1,9})?$/.test(s)) throw new Error('Invalid SOL amount');
    const [w, f = ''] = s.split('.');
    return BigInt(w) * LAMPORTS_PER_SOL + BigInt((f + '000000000').slice(0, 9));
  }

  function tokenAmount(raw, decimals) {
    const r = BigInt(raw);
    if (!decimals) return r.toString();
    const base = 10n ** BigInt(decimals);
    const whole = r / base;
    const frac = (r % base).toString().padStart(decimals, '0').replace(/0+$/, '');
    return frac ? whole + '.' + frac : whole.toString();
  }

  function view(data) {
    return new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  function keyStr(k) {
    if (typeof k === 'string') return k;
    if (k && typeof k.toBase58 === 'function') return k.toBase58();
    return String(k);
  }

  // ---------- normalise web3.js transactions into one simple shape ----------
  function normalize(tx) {
    // Versioned (v0) transaction
    if (tx && tx.message && tx.message.compiledInstructions) {
      const m = tx.message;
      const keys = m.staticAccountKeys.map(keyStr);
      const nStatic = keys.length;
      const h = m.header;
      const isSigner = (i) => i < h.numRequiredSignatures;
      const isWritable = (i) =>
        i < h.numRequiredSignatures
          ? i < h.numRequiredSignatures - h.numReadonlySignedAccounts
          : i < nStatic - h.numReadonlyUnsignedAccounts;
      const lookups = m.addressTableLookups || [];
      const lookupCount = lookups.reduce(
        (n, l) => n + l.writableIndexes.length + l.readonlyIndexes.length,
        0
      );
      return {
        feePayer: keys[0],
        unresolved: lookupCount > 0,
        instructions: m.compiledInstructions.map((ci) => ({
          programId: keys[ci.programIdIndex],
          keys: ci.accountKeyIndexes.map((i) => ({
            pubkey: i < nStatic ? keys[i] : '<lookup-table account>',
            isSigner: i < nStatic && isSigner(i),
            isWritable: i < nStatic ? isWritable(i) : true,
          })),
          data: ci.data,
        })),
      };
    }
    // Legacy transaction
    const feePayer =
      (tx.feePayer && keyStr(tx.feePayer)) ||
      (tx.signatures && tx.signatures[0] && keyStr(tx.signatures[0].publicKey)) ||
      null;
    return {
      feePayer,
      unresolved: false,
      instructions: tx.instructions.map((ix) => ({
        programId: keyStr(ix.programId),
        keys: ix.keys.map((k) => ({
          pubkey: keyStr(k.pubkey),
          isSigner: !!k.isSigner,
          isWritable: !!k.isWritable,
        })),
        data: ix.data,
      })),
    };
  }

  // Accepts a base64 serialized transaction. `web3` is the @solana/web3.js module (or solanaWeb3 global).
  function fromBase64(b64, web3) {
    const clean = String(b64).trim();
    let bytes;
    if (typeof Buffer !== 'undefined') bytes = Uint8Array.from(Buffer.from(clean, 'base64'));
    else bytes = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
    try {
      return web3.VersionedTransaction.deserialize(bytes);
    } catch (e) {
      return web3.Transaction.from(bytes);
    }
  }

  // ---------- prompt-injection and hidden-text scanner ----------
  const INJECTION_PATTERNS = [
    [/ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i, 'tells an AI to ignore its instructions'],
    [/(system|developer)\s+prompt/i, 'refers to an AI system prompt'],
    [/\byou\s+are\s+(now|an?)\b/i, 'tries to reassign an AI\'s role'],
    [/(send|transfer|drain|move|withdraw)\s+(all|everything|the\s+entire|your)\s+(of\s+)?(funds|sol|tokens|balance|wallet|usdc)/i, 'tells an AI to move all funds'],
    [/(seed\s*phrase|private\s*key|secret\s*key|recovery\s*phrase|mnemonic)/i, 'asks for secrets'],
    [/do\s+not\s+(tell|inform|show|warn|alert)\s+(the\s+)?user/i, 'asks an AI to hide things from you'],
    [/(approve|sign|confirm)\s+(this\s+)?(transaction\s+)?(immediately|without\s+(asking|checking|review))/i, 'pushes an AI to sign without review'],
  ];
  const HIDDEN_CHARS = /[​-‏‪-‮⁠-⁤﻿]/;

  function scanText(text, where) {
    const out = [];
    const t = String(text == null ? '' : text);
    const place = where ? ' in ' + where : '';
    for (const [re, why] of INJECTION_PATTERNS) {
      if (re.test(t)) {
        out.push({
          level: 'block',
          code: 'PROMPT_INJECTION',
          msg: 'Text' + place + ' ' + why + '. This looks like an attempt to steer an AI agent.',
        });
      }
    }
    if (HIDDEN_CHARS.test(t)) {
      out.push({
        level: 'warn',
        code: 'HIDDEN_TEXT',
        msg: 'Text' + place + ' contains invisible characters that can hide instructions.',
      });
    }
    return out;
  }

  // ---------- token mint check (feed it the "parsed" account info from the RPC) ----------
  function analyzeMint(parsed) {
    const out = [];
    const info = (parsed && parsed.info) || {};
    const program = parsed && parsed.program;
    if (info.freezeAuthority) {
      out.push({ level: 'warn', code: 'FREEZE_AUTHORITY', msg: 'The token issuer can freeze your balance at any time.' });
    }
    if (info.mintAuthority) {
      out.push({ level: 'info', code: 'MINT_AUTHORITY', msg: 'The issuer can still create more of this token, which can dilute holders.' });
    }
    const exts = Array.isArray(info.extensions) ? info.extensions : [];
    for (const e of exts) {
      const name = e.extension;
      if (name === 'permanentDelegate') {
        out.push({ level: 'block', code: 'PERMANENT_DELEGATE', msg: 'Token-2022 permanent delegate: the issuer can move or burn this token out of ANY holder\'s account.' });
      } else if (name === 'transferHook') {
        out.push({ level: 'warn', code: 'TRANSFER_HOOK', msg: 'Token-2022 transfer hook: custom code runs every time this token moves.' });
      } else if (name === 'transferFeeConfig') {
        out.push({ level: 'warn', code: 'TRANSFER_FEE', msg: 'Token-2022 transfer fee: a cut is taken on every transfer.' });
      } else if (name === 'defaultAccountState' && e.state && e.state.accountState === 'frozen') {
        out.push({ level: 'warn', code: 'DEFAULT_FROZEN', msg: 'New token accounts start frozen until the issuer unfreezes them.' });
      } else if (name === 'pausableConfig') {
        out.push({ level: 'warn', code: 'PAUSABLE', msg: 'The issuer can pause all transfers of this token.' });
      } else if (name === 'nonTransferable') {
        out.push({ level: 'info', code: 'NON_TRANSFERABLE', msg: 'This token cannot be transferred once received.' });
      }
    }
    if (program === 'spl-token-2022' && !exts.length) {
      out.push({ level: 'info', code: 'TOKEN_2022', msg: 'Token-2022 token with no extensions found.' });
    }
    return out;
  }

  // ---------- simulation check ----------
  function analyzeSimulation(sim) {
    const out = [];
    if (!sim) return out;
    if (sim.err) {
      out.push({
        level: 'block',
        code: 'SIMULATION_FAILED',
        msg: 'The simulation shows this transaction would fail: ' + (typeof sim.err === 'string' ? sim.err : JSON.stringify(sim.err)),
      });
    }
    const logs = sim.logs || [];
    for (const line of logs) {
      const found = scanText(line, 'a program log');
      for (const f of found) out.push(f);
    }
    return out;
  }

  // ---------- the main analysis ----------
  function analyze(tx, ctx) {
    ctx = ctx || {};
    const t = normalize(tx);
    const owner = ctx.owner || t.feePayer;
    const p = ctx.policy || {};
    const policy = {
      dailyLimitLamports: p.dailyLimitLamports == null ? null : BigInt(p.dailyLimitLamports),
      spentTodayLamports: BigInt(p.spentTodayLamports || 0),
      allowlist: p.allowlist || [],
      enforceAllowlist: p.enforceAllowlist !== false,
    };
    const trusted = Object.assign({}, KNOWN_NAMES, ctx.trustedPrograms || {});

    const findings = [];
    const lines = [];
    const programs = [];
    const recipients = [];
    let outflow = 0n;

    const add = (level, code, msg) => findings.push({ level, code, msg });
    const names = ctx.labels || {};
    const label = (a) => (a === owner ? 'your wallet' : names[a] ? names[a] + ' (' + short(a) + ')' : short(a));
    const ownerSigns = (ix) => ix.keys.some((k) => k.pubkey === owner && k.isSigner);

    function checkRecipient(to) {
      if (to === owner) return;
      if (to === '<lookup-table account>') {
        add('warn', 'UNRESOLVED_ACCOUNTS', 'A recipient is hidden behind an address lookup table, so it cannot be checked against your allowlist.');
        return;
      }
      if (!recipients.includes(to)) recipients.push(to);
      if (!policy.allowlist.includes(to)) {
        if (policy.enforceAllowlist) {
          add('block', 'RECIPIENT_NOT_ALLOWED', short(to) + ' is not on your allowlist, so your spending policy would reject this.');
        } else {
          add('warn', 'NEW_RECIPIENT', short(to) + ' is a new address you have not approved before.');
        }
      }
    }

    t.instructions.forEach((ix, idx) => {
      const pid = ix.programId;
      if (!programs.includes(pid)) programs.push(pid);
      const data = ix.data || new Uint8Array(0);
      const dv = data.length ? view(data) : null;

      // ----- System program -----
      if (pid === PROGRAMS.SYSTEM) {
        const kind = dv && data.length >= 4 ? dv.getUint32(0, true) : -1;
        if (kind === 2 && data.length >= 12) {
          const lamports = dv.getBigUint64(4, true);
          const from = ix.keys[0].pubkey;
          const to = ix.keys[1].pubkey;
          lines.push('Sends ' + sol(lamports) + ' SOL from ' + label(from) + ' to ' + label(to) + '.');
          if (from === owner) {
            outflow += lamports;
            checkRecipient(to);
          }
        } else if (kind === 11 && data.length >= 12) {
          const lamports = dv.getBigUint64(4, true);
          const base = ix.keys[1].pubkey;
          const to = ix.keys[2].pubkey;
          lines.push('Sends ' + sol(lamports) + ' SOL from a derived account to ' + label(to) + '.');
          if (base === owner) {
            outflow += lamports;
            checkRecipient(to);
          }
        } else if (kind === 0 && data.length >= 52) {
          const lamports = dv.getBigUint64(4, true);
          const newOwner = b58encode(data.slice(20, 52));
          const funder = ix.keys[0].pubkey;
          lines.push('Creates a new account holding ' + sol(lamports) + ' SOL, owned by ' + (trusted[newOwner] || short(newOwner)) + '.');
          if (funder === owner) outflow += lamports;
        } else if (kind === 1 && data.length >= 36) {
          const newOwner = b58encode(data.slice(4, 36));
          const acct = ix.keys[0].pubkey;
          if (acct === owner && newOwner !== PROGRAMS.SYSTEM) {
            lines.push('Hands control of your wallet itself to ' + short(newOwner) + '.');
            add('block', 'ASSIGN_WALLET', 'This reassigns ownership of your wallet account to another program, which is a wallet-takeover pattern.');
          } else {
            lines.push('Changes which program owns account ' + short(acct) + '.');
            add('warn', 'ASSIGN_ACCOUNT', 'Reassigns ownership of an account to ' + (trusted[newOwner] || short(newOwner)) + '.');
          }
        } else if (kind === 4) {
          lines.push('Uses a durable nonce instead of a recent blockhash.');
          if (idx === 0) {
            add('warn', 'DURABLE_NONCE', 'This transaction never expires. Someone could hold it and submit it later, which is a common phishing trick.');
          }
        } else if (kind === 5 || kind === 7) {
          lines.push(kind === 5 ? 'Withdraws SOL from a nonce account.' : 'Changes who controls a nonce account.');
          add('warn', 'NONCE_ADMIN', 'Nonce account administration is unusual in a normal payment.');
        } else if (kind === 8 || kind === 9) {
          lines.push('Resizes an account.');
        } else {
          lines.push('Runs a System Program instruction (type ' + kind + ').');
        }
        return;
      }

      // ----- Token / Token-2022 -----
      if (pid === PROGRAMS.TOKEN || pid === PROGRAMS.TOKEN_2022) {
        const kind = data.length ? data[0] : -1;
        const tag = pid === PROGRAMS.TOKEN_2022 ? ' (Token-2022)' : '';
        if (kind === 3 && data.length >= 9) {
          const amt = dv.getBigUint64(1, true);
          const dest = ix.keys[1].pubkey;
          lines.push('Transfers ' + amt + ' raw token units to token account ' + short(dest) + tag + '.');
          if (ix.keys[2] && ix.keys[2].pubkey === owner) {
            add('warn', 'TOKEN_TRANSFER_UNCOVERED', 'Token transfers are not covered by your SOL spending limit. Check the destination yourself.');
          }
        } else if (kind === 12 && data.length >= 10) {
          const amt = dv.getBigUint64(1, true);
          const dec = data[9];
          const dest = ix.keys[2].pubkey;
          lines.push('Transfers ' + tokenAmount(amt, dec) + ' of token ' + short(ix.keys[1].pubkey) + ' to token account ' + short(dest) + tag + '.');
          if (ix.keys[3] && ix.keys[3].pubkey === owner) {
            add('warn', 'TOKEN_TRANSFER_UNCOVERED', 'Token transfers are not covered by your SOL spending limit. Check the destination yourself.');
          }
        } else if ((kind === 4 && data.length >= 9) || (kind === 13 && data.length >= 10)) {
          const amt = dv.getBigUint64(1, true);
          const delegate = kind === 4 ? ix.keys[1].pubkey : ix.keys[2].pubkey;
          if (amt === U64_MAX) {
            lines.push('Lets ' + short(delegate) + ' spend ALL the tokens in this account, with no limit' + tag + '.');
            add('block', 'UNLIMITED_APPROVAL', short(delegate) + ' would get unlimited permission to spend this token account.');
          } else {
            lines.push('Lets ' + short(delegate) + ' spend up to ' + amt + ' raw token units' + tag + '.');
            add('warn', 'TOKEN_APPROVAL', 'Gives ' + short(delegate) + ' permission to spend tokens from your account.');
          }
        } else if (kind === 5) {
          lines.push('Revokes a token spending permission' + tag + '.');
        } else if (kind === 6 && data.length >= 2) {
          const type = data[1];
          const hasNew = data.length >= 3 && data[2] === 1;
          const newAuth = hasNew && data.length >= 35 ? b58encode(data.slice(3, 35)) : null;
          const names = ['mint authority', 'freeze authority', 'account owner', 'close authority'];
          const what = names[type] || 'authority';
          const who = newAuth ? short(newAuth) : 'nobody';
          lines.push('Changes the ' + what + ' of ' + short(ix.keys[0].pubkey) + ' to ' + who + tag + '.');
          if (type === 2) {
            add('block', 'SET_OWNER', 'This hands ownership of a token account to ' + who + '. It is the classic way token accounts get drained.');
          } else if (type === 3) {
            add('warn', 'SET_CLOSE_AUTHORITY', 'Gives ' + who + ' the power to close this token account.');
          } else {
            add('warn', 'SET_MINT_AUTHORITY', 'Changes the ' + what + ' of a token to ' + who + '.');
          }
        } else if (kind === 9) {
          const dest = ix.keys[1].pubkey;
          lines.push('Closes token account ' + short(ix.keys[0].pubkey) + ' and sends its remaining SOL to ' + label(dest) + tag + '.');
          if (dest !== owner) {
            add('warn', 'CLOSE_TO_OTHER', 'Closing sends the leftover rent to ' + short(dest) + ' instead of you.');
          }
        } else if (kind === 8 || kind === 15) {
          lines.push('Burns (destroys) tokens' + tag + '.');
          add('warn', 'TOKEN_BURN', 'Burning tokens cannot be undone.');
        } else if (kind === 7 || kind === 14) {
          lines.push('Mints new tokens' + tag + '.');
        } else if (kind === 1 || kind === 18 || kind === 17 || kind === 20 || kind === 16 || kind === 19) {
          lines.push('Sets up a token account or mint' + tag + '.');
        } else {
          lines.push('Runs a token instruction (type ' + kind + ')' + tag + '.');
          if (kind >= 25) add('info', 'TOKEN_EXTENSION_IX', 'Uses a Token-2022 extension instruction.');
        }
        return;
      }

      // ----- Associated token account -----
      if (pid === PROGRAMS.ATA) {
        lines.push('Creates a token account for ' + label(ix.keys[2] ? ix.keys[2].pubkey : '?') + ' if it does not exist.');
        return;
      }

      // ----- Memo -----
      if (pid === PROGRAMS.MEMO || pid === PROGRAMS.MEMO_V1) {
        let text = '';
        try {
          text = new TextDecoder('utf-8').decode(data);
        } catch (e) {
          text = '';
        }
        lines.push('Attaches a memo: "' + (text.length > 60 ? text.slice(0, 60) + '…' : text) + '".');
        for (const f of scanText(text, 'the memo')) findings.push(f);
        return;
      }

      // ----- Compute budget -----
      if (pid === PROGRAMS.COMPUTE_BUDGET) {
        lines.push('Sets compute limits or priority fee.');
        return;
      }

      // ----- Anything else -----
      const name = trusted[pid];
      if (name) {
        lines.push('Calls ' + name + ' (' + short(pid) + ') with ' + ix.keys.length + ' accounts.');
        if (ownerSigns(ix) && !KNOWN_NAMES[pid]) {
          add('info', 'TRUSTED_PROGRAM_SIGNER', name + ' will act with your signature.');
        }
      } else {
        lines.push('Calls an unrecognized program (' + short(pid) + ') with ' + ix.keys.length + ' accounts.');
        if (ownerSigns(ix)) {
          add('warn', 'UNKNOWN_PROGRAM_SIGNER', 'Unverified program ' + short(pid) + ' acts with your signature. It can do anything your wallet is allowed to do.');
        } else {
          add('warn', 'UNKNOWN_PROGRAM', 'Calls an unverified program: ' + short(pid) + '.');
        }
      }
    });

    // ----- whole-transaction checks -----
    if (outflow > 0n) {
      if (policy.dailyLimitLamports != null) {
        const total = policy.spentTodayLamports + outflow;
        if (total > policy.dailyLimitLamports) {
          add(
            'block',
            'DAILY_LIMIT_EXCEEDED',
            'This would bring today\'s spending to ' + sol(total) + ' SOL, over your ' + sol(policy.dailyLimitLamports) + ' SOL daily limit.'
          );
        }
      }
      if (ctx.balanceLamports != null) {
        const bal = BigInt(ctx.balanceLamports);
        if (bal > 0n && outflow * 10n >= bal * 9n) {
          add('warn', 'DRAIN_PATTERN', 'This moves ' + sol(outflow) + ' SOL, 90% or more of your balance.');
        }
      }
    }
    if (t.unresolved) {
      add('warn', 'UNRESOLVED_ACCOUNTS', 'Some accounts are loaded from lookup tables and cannot be fully inspected offline.');
    }
    if (t.instructions.length > 10) {
      add('warn', 'MANY_INSTRUCTIONS', 'Unusually long transaction (' + t.instructions.length + ' instructions). Long ones are harder to review.');
    }

    // ----- verdict -----
    const weight = { block: 60, warn: 20, info: 0 };
    const score = Math.min(100, findings.reduce((s, f) => s + (weight[f.level] || 0), 0));
    let verdict = 'SAFE';
    if (findings.some((f) => f.level === 'warn')) verdict = 'REVIEW';
    if (findings.some((f) => f.level === 'block')) verdict = 'BLOCK';

    return {
      verdict,
      score,
      findings,
      lines,
      outflowLamports: outflow,
      recipients,
      programs,
      feePayer: t.feePayer,
    };
  }

  // Merge extra findings (mint check, simulation, text scan) into an analysis result.
  function merge(result, extra) {
    const findings = result.findings.concat(extra || []);
    const weight = { block: 60, warn: 20, info: 0 };
    const score = Math.min(100, findings.reduce((s, f) => s + (weight[f.level] || 0), 0));
    let verdict = 'SAFE';
    if (findings.some((f) => f.level === 'warn')) verdict = 'REVIEW';
    if (findings.some((f) => f.level === 'block')) verdict = 'BLOCK';
    return Object.assign({}, result, { findings, score, verdict });
  }

  // ---------- chat intent parser ----------
  function parseIntent(text) {
    const raw = String(text || '').trim();
    const t = raw.toLowerCase();
    if (!t) return { type: 'empty' };

    let m = raw.match(/(?:send|transfer|pay)\s+(\d+(?:\.\d+)?)\s*(?:sol)?\s+to\s+([1-9A-HJ-NP-Za-km-z]{32,44})/i);
    if (m) return { type: 'send', amountSol: m[1], to: m[2] };

    m = raw.match(/(?:allow|whitelist|approve|trust)\s+([1-9A-HJ-NP-Za-km-z]{32,44})/i);
    if (m) return { type: 'allow', address: m[1] };

    m = raw.match(/(?:remove|block|disallow)\s+([1-9A-HJ-NP-Za-km-z]{32,44})/i);
    if (m) return { type: 'disallow', address: m[1] };

    m = t.match(/(?:set\s+)?(?:daily\s+)?limit\s+(?:to\s+)?(\d+(?:\.\d+)?)/);
    if (m) return { type: 'set_limit', amountSol: m[1] };

    if (/\bpause\b|freeze\s+agent|stop\s+agent/.test(t)) return { type: 'pause' };
    if (/\bresume\b|unpause/.test(t)) return { type: 'resume' };
    if (/\bswap\b|\bbuy\b|\bsell\b/.test(t)) return { type: 'swap' };
    if (/balance|how much/.test(t)) return { type: 'balance' };
    if (/risk|audit|safe|check my wallet|scan/.test(t)) return { type: 'audit' };
    if (/help|what can you do/.test(t)) return { type: 'help' };
    return { type: 'unknown', text: raw };
  }

  return {
    PROGRAMS,
    analyze,
    merge,
    scanText,
    analyzeMint,
    analyzeSimulation,
    parseIntent,
    fromBase64,
    normalize,
    isValidAddress,
    b58encode,
    b58decode,
    sol,
    solToLamports,
    tokenAmount,
    short,
  };
});a
