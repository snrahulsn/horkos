import { webcrypto } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { sha256 as nobleSha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
// noble-ed25519 v2 needs sha512 wired for sync ops
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));
// Node 18 compat
if (!globalThis.crypto) {
    globalThis.crypto = webcrypto;
}
export function sha256Hex(data) {
    const bytes = typeof data === 'string' ? utf8ToBytes(data) : data;
    return bytesToHex(nobleSha256(bytes));
}
/** Deterministic JSON: sorted keys, no whitespace. Hash-stable across runs. */
export function canonicalJson(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys
        .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
        .join(',')}}`;
}
export function commitmentHash(commitment) {
    return sha256Hex(canonicalJson(commitment));
}
export function generateKeypair() {
    const priv = ed.utils.randomPrivateKey();
    const pub = ed.getPublicKey(priv);
    return { pubkey: bytesToHex(pub), privkey: bytesToHex(priv) };
}
export function sign(messageHex, privkeyHex) {
    return bytesToHex(ed.sign(hexToBytes(messageHex), hexToBytes(privkeyHex)));
}
export function verify(signatureHex, messageHex, pubkeyHex) {
    try {
        return ed.verify(hexToBytes(signatureHex), hexToBytes(messageHex), hexToBytes(pubkeyHex));
    }
    catch {
        return false;
    }
}
/** Sign a UTF-8 string (hashes it first). */
export function signText(text, privkeyHex) {
    return sign(sha256Hex(text), privkeyHex);
}
export function randomToken() {
    const bytes = new Uint8Array(32);
    webcrypto.getRandomValues(bytes);
    return bytesToHex(bytes);
}
//# sourceMappingURL=crypto.js.map