// Ethereum personal_sign (EIP-191) verification in pure JS: Keccak-256 + secp256k1 public-key
// recovery on native BigInt. Zero dependencies (node:crypto is only used for the RFC 6979 HMAC in the
// test-only signer). Not constant-time: fine for verifying public signatures, NOT for guarding keys.

const crypto = require("node:crypto");

// ---------- Keccak-f[1600] sponge (64-bit lanes as BigInt) ----------
const MASK64 = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
// rotation offsets, indexed x + 5y
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14].map(BigInt);
// pi: lane (x, y) moves to (y, 2x + 3y)
const PI = Array.from({ length: 25 }, (_, i) => {
  const x = i % 5, y = (i / 5) | 0;
  return y + 5 * ((2 * x + 3 * y) % 5);
});
const rotl = (v, r) => (r === 0n ? v : ((v << r) | (v >> (64n - r))) & MASK64);

function keccakF(A) {
  const C = new Array(5), B = new Array(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1n);
      for (let y = 0; y < 25; y += 5) A[x + y] ^= D;
    }
    for (let i = 0; i < 25; i++) B[PI[i]] = rotl(A[i], ROT[i]);
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) A[x + y] = B[x + y] ^ (~B[((x + 1) % 5) + y] & MASK64 & B[((x + 2) % 5) + y]);
    }
    A[0] ^= RC[round];
  }
}

const toBytes = (input) => {
  if (typeof input === "string") return Buffer.from(input, "utf8");
  if (input instanceof Uint8Array) return input;
  throw new TypeError("expected a string or bytes");
};

// Sponge with a 136-byte rate and 32-byte output. dsByte 0x01 = Keccak-256 (Ethereum), 0x06 = SHA3-256.
function sponge256(input, dsByte) {
  const msg = toBytes(input);
  const RATE = 136;
  const padded = new Uint8Array((Math.floor(msg.length / RATE) + 1) * RATE);
  padded.set(msg);
  padded[msg.length] ^= dsByte;
  padded[padded.length - 1] ^= 0x80;
  const A = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      A[i] ^= lane;
    }
    keccakF(A);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) {
    let lane = A[i];
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}
const keccak256 = (input) => sponge256(input, 0x01); // Buffer(32)
const keccak256Hex = (input) => keccak256(input).toString("hex");

// ---------- secp256k1 ----------
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
const mod = (a, m) => {
  const r = a % m;
  return r < 0n ? r + m : r;
};
function powMod(b, e, m) {
  let r = 1n;
  b = mod(b, m);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}
// modular inverse by the extended Euclid algorithm (a != 0 mod m)
function invMod(a, m) {
  let [r0, r1] = [mod(a, m), m];
  let [s0, s1] = [1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  if (r0 !== 1n) throw new RangeError("not invertible");
  return mod(s0, m);
}

// Jacobian points [X, Y, Z]; Z = 0 is the point at infinity. Curve y^2 = x^3 + 7 (a = 0).
const INF = [0n, 1n, 0n];
function jDouble([X, Y, Z]) {
  if (Z === 0n || Y === 0n) return INF;
  const YY = (Y * Y) % P;
  const S = (4n * X * YY) % P;
  const M = (3n * X * X) % P;
  const X3 = mod(M * M - 2n * S, P);
  const Y3 = mod(M * (S - X3) - 8n * YY * YY, P);
  const Z3 = (2n * Y * Z) % P;
  return [X3, Y3, Z3];
}
function jAdd(p1, p2) {
  if (p1[2] === 0n) return p2;
  if (p2[2] === 0n) return p1;
  const [X1, Y1, Z1] = p1, [X2, Y2, Z2] = p2;
  const Z1Z1 = (Z1 * Z1) % P, Z2Z2 = (Z2 * Z2) % P;
  const U1 = (X1 * Z2Z2) % P, U2 = (X2 * Z1Z1) % P;
  const S1 = (Y1 * Z2 * Z2Z2) % P, S2 = (Y2 * Z1 * Z1Z1) % P;
  if (U1 === U2) return S1 === S2 ? jDouble(p1) : INF;
  const H = mod(U2 - U1, P), R = mod(S2 - S1, P);
  const HH = (H * H) % P, HHH = (H * HH) % P, V = (U1 * HH) % P;
  const X3 = mod(R * R - HHH - 2n * V, P);
  const Y3 = mod(R * (V - X3) - S1 * HHH, P);
  const Z3 = (H * Z1 * Z2) % P;
  return [X3, Y3, Z3];
}
function jMul(pt, k) {
  let acc = INF;
  for (let i = BigInt(k.toString(2).length - 1); i >= 0n; i--) {
    acc = jDouble(acc);
    if ((k >> i) & 1n) acc = jAdd(acc, pt);
  }
  return acc;
}
function toAffine([X, Y, Z]) {
  if (Z === 0n) return null;
  const zi = invMod(Z, P), zi2 = (zi * zi) % P;
  return [(X * zi2) % P, (Y * zi2 * zi) % P];
}
const G = [GX, GY, 1n];

const hex32 = (v) => v.toString(16).padStart(64, "0");
const bigFrom = (buf) => (buf.length ? BigInt("0x" + Buffer.from(buf).toString("hex")) : 0n);
// 64-byte public key (x || y, no 04 prefix) -> lowercase 0x address
const addressFromPoint = ([x, y]) => "0x" + keccak256(Buffer.from(hex32(x) + hex32(y), "hex")).subarray(12).toString("hex");

function publicKeyFromPrivate(priv) {
  if (typeof priv !== "bigint" || priv <= 0n || priv >= N) throw new RangeError("bad private key");
  return toAffine(jMul(G, priv));
}
const addressFromPrivate = (priv) => addressFromPoint(publicKeyFromPrivate(priv));

// EIP-191 version 0x45: keccak256("\x19Ethereum Signed Message:\n" + byte length + message)
function personalDigest(message) {
  const body = toBytes(message);
  const prefix = Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`, "utf8");
  return keccak256(Buffer.concat([prefix, Buffer.from(body)]));
}

// Recover the signer of a 32-byte digest. r, s in [1, n-1]; recid 0/1 (x = r, never r + n).
function recoverDigest(digest, r, s, recid) {
  if (r <= 0n || r >= N || s <= 0n || s >= N || (recid !== 0 && recid !== 1)) return null;
  const x = r;
  const y2 = mod(x * x * x + 7n, P);
  let y = powMod(y2, (P + 1n) / 4n, P);
  if ((y * y) % P !== y2) return null; // r is not the x of a curve point
  if (Number(y & 1n) !== recid) y = P - y;
  const e = mod(bigFrom(digest), N);
  const rInv = invMod(r, N);
  const u1 = mod(-e * rInv, N), u2 = mod(s * rInv, N);
  const Q = toAffine(jAdd(jMul(G, u1), jMul([x, y, 1n], u2)));
  return Q ? addressFromPoint(Q) : null;
}

// Split a 65-byte r || s || v signature (hex with or without 0x, or bytes). null when malformed.
function parseSignature(signature) {
  let buf;
  if (typeof signature === "string") {
    const h = signature.startsWith("0x") || signature.startsWith("0X") ? signature.slice(2) : signature;
    if (!/^[0-9a-fA-F]{130}$/.test(h)) return null;
    buf = Buffer.from(h, "hex");
  } else if (signature instanceof Uint8Array && signature.length === 65) buf = Buffer.from(signature);
  else return null;
  const v = buf[64];
  const recid = v === 27 || v === 28 ? v - 27 : v === 0 || v === 1 ? v : -1;
  if (recid < 0) return null;
  return { r: bigFrom(buf.subarray(0, 32)), s: bigFrom(buf.subarray(32, 64)), recid };
}

// personal_sign signature -> lowercase 0x address of the signer, or null. High-s is accepted.
function recoverPersonalSig(message, signature) {
  try {
    const sig = parseSignature(signature);
    if (!sig) return null;
    return recoverDigest(personalDigest(message), sig.r, sig.s, sig.recid);
  } catch {
    return null;
  }
}

// ---------- test-only signer (RFC 6979 deterministic nonce, HMAC-SHA256) ----------
const hmac = (key, ...parts) => {
  const h = crypto.createHmac("sha256", key);
  for (const p of parts) h.update(p);
  return h.digest();
};
function signDigest(digest, priv) {
  if (typeof priv !== "bigint" || priv <= 0n || priv >= N) throw new RangeError("bad private key");
  const z = mod(bigFrom(digest), N);
  const x = Buffer.from(hex32(priv), "hex");
  const h = Buffer.from(hex32(z), "hex");
  let V = Buffer.alloc(32, 1), K = Buffer.alloc(32, 0);
  K = hmac(K, V, Buffer.from([0]), x, h);
  V = hmac(K, V);
  K = hmac(K, V, Buffer.from([1]), x, h);
  V = hmac(K, V);
  for (;;) {
    V = hmac(K, V);
    const k = bigFrom(V);
    if (k > 0n && k < N) {
      const R = toAffine(jMul(G, k));
      const r = mod(R[0], N);
      let s = mod(invMod(k, N) * (z + r * priv), N);
      let recid = Number(R[1] & 1n);
      if (r !== 0n && s !== 0n && R[0] < N) {
        if (s > N / 2n) {
          s = N - s; // low-s, as wallets emit
          recid ^= 1;
        }
        return { r, s, recid };
      }
    }
    K = hmac(K, V, Buffer.from([0]));
    V = hmac(K, V);
  }
}
// personal_sign(message) with a BigInt private key -> 0x + 130 hex (v = 27/28). Tests only.
function signPersonal(message, priv) {
  const { r, s, recid } = signDigest(personalDigest(message), priv);
  return "0x" + hex32(r) + hex32(s) + (27 + recid).toString(16);
}

const sha3_256 = (input) => sponge256(input, 0x06); // only to cross-check the sponge against node:crypto

module.exports = {
  keccak256, keccak256Hex, personalDigest, recoverPersonalSig, signPersonal,
  addressFromPrivate, publicKeyFromPrivate, recoverDigest, signDigest, parseSignature, sha3_256, N, P,
};
