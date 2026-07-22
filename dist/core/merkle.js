import { pool } from '../db/pool.js';
import { sha256Hex, sign } from './crypto.js';
/**
 * Hourly signed Merkle root over new entry_log rows.
 * UI says only: "records cannot be altered or removed."
 */
function merkleRoot(leaves) {
    if (!leaves.length)
        return sha256Hex('EMPTY');
    let level = leaves.map((l) => sha256Hex(l));
    while (level.length > 1) {
        const next = [];
        for (let i = 0; i < level.length; i += 2) {
            next.push(i + 1 < level.length ? sha256Hex(level[i] + level[i + 1]) : level[i]);
        }
        level = next;
    }
    return level[0];
}
export async function publishMerkleRoot() {
    const seed = process.env.MERKLE_SIGNING_SEED;
    if (!seed)
        return; // unsigned deployments skip publication
    const last = await pool.query(`SELECT coalesce(max(to_seq), 0) AS last FROM merkle_roots`);
    const fromSeq = Number(last.rows[0].last) + 1;
    const { rows } = await pool.query(`SELECT seq, this_hash FROM entry_log WHERE seq >= $1 ORDER BY seq`, [fromSeq]);
    if (!rows.length)
        return;
    const root = merkleRoot(rows.map((r) => r.this_hash));
    const signature = sign(root, seed);
    await pool.query(`INSERT INTO merkle_roots (from_seq, to_seq, root, signature) VALUES ($1,$2,$3,$4)`, [fromSeq, rows[rows.length - 1].seq, root, signature]);
    console.log(`merkle root published: seq ${fromSeq}..${rows[rows.length - 1].seq}`);
}
export async function listMerkleRoots(limit = 100) {
    const { rows } = await pool.query(`SELECT from_seq, to_seq, root, signature, signed_at FROM merkle_roots ORDER BY signed_at DESC LIMIT $1`, [limit]);
    return rows;
}
//# sourceMappingURL=merkle.js.map