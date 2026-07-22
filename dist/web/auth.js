import { createHmac, timingSafeEqual } from 'node:crypto';
/**
 * Operator login (spec §5). Supabase Auth email OTP / magic-link.
 * We never hold a password. The browser gets an access token from
 * Supabase; the server verifies it against Supabase's /auth/v1/user,
 * then issues its own signed, httpOnly session cookie.
 */
export function supabaseConfig() {
    const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '';
    return { url: url.replace(/\/$/, ''), anonKey };
}
export function authConfigured() {
    const { url, anonKey } = supabaseConfig();
    return Boolean(url && anonKey && process.env.SESSION_SECRET);
}
/** Verify a Supabase access token by asking Supabase who it belongs to. */
export async function verifyAccessToken(accessToken) {
    const { url, anonKey } = supabaseConfig();
    if (!url || !anonKey)
        return null;
    try {
        const res = await fetch(`${url}/auth/v1/user`, {
            headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok)
            return null;
        const u = (await res.json());
        if (!u.id)
            return null;
        return { id: u.id, email: u.email ?? null };
    }
    catch {
        return null;
    }
}
// ---- session cookie (signed, httpOnly) ----
const COOKIE = 'horkos_session';
const MAX_AGE_S = 60 * 60 * 12; // 12h
function secret() {
    return process.env.SESSION_SECRET || '';
}
function sign(payload) {
    return createHmac('sha256', secret()).update(payload).digest('base64url');
}
/** value = base64url(json).signature */
export function makeSession(user) {
    const body = Buffer.from(JSON.stringify({ id: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + MAX_AGE_S })).toString('base64url');
    return `${body}.${sign(body)}`;
}
export function readSession(cookieValue) {
    if (!cookieValue)
        return null;
    const [body, sig] = cookieValue.split('.');
    if (!body || !sig)
        return null;
    const expected = sign(body);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b))
        return null;
    try {
        const p = JSON.parse(Buffer.from(body, 'base64url').toString());
        if (!p.id || (p.exp && p.exp * 1000 < Date.now()))
            return null;
        return { id: p.id, email: p.email ?? null };
    }
    catch {
        return null;
    }
}
export function sessionCookie(value) {
    return `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_S}`;
}
export function clearCookie() {
    return `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
export function readCookie(header) {
    if (!header)
        return undefined;
    for (const part of header.split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k === COOKIE)
            return v.join('=');
    }
    return undefined;
}
//# sourceMappingURL=auth.js.map