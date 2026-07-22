import { canonicalJson, sha256Hex } from './crypto.js';
const GENESIS = sha256Hex('HORKOS-GENESIS');
/**
 * Append an event to the tamper-evident log. Each row chains the prior
 * row's hash. Payloads are skeleton-level only — never method text.
 * Must be called inside the same transaction as the mutation it records.
 */
export async function logEvent(client, eventType, payload) {
    // Serialize appends: lock the last row's slot.
    const { rows } = await client.query(`SELECT this_hash FROM entry_log ORDER BY seq DESC LIMIT 1 FOR UPDATE`);
    const prevHash = rows.length ? rows[0].this_hash : GENESIS;
    const canonical = canonicalJson(payload);
    const thisHash = sha256Hex(prevHash + eventType + canonical);
    await client.query(`INSERT INTO entry_log (event_type, payload, prev_hash, this_hash) VALUES ($1, $2, $3, $4)`, [eventType, canonical, prevHash, thisHash]);
}
/** Verify the whole chain. Returns first broken seq, or null if intact. */
export async function verifyChain(client) {
    const { rows } = await client.query(`SELECT seq, event_type, payload, prev_hash, this_hash FROM entry_log ORDER BY seq`);
    let prev = GENESIS;
    for (const row of rows) {
        if (row.prev_hash !== prev)
            return BigInt(row.seq);
        const expected = sha256Hex(row.prev_hash + row.event_type + canonicalJson(row.payload));
        if (row.this_hash !== expected)
            return BigInt(row.seq);
        prev = row.this_hash;
    }
    return null;
}
//# sourceMappingURL=entrylog.js.map