import { z } from 'zod';
/**
 * §6 — "you can't swear to shit."
 * Freeform promises do not exist. Everything here rejects at the tool layer.
 */
// ---------- criteria taxonomy (machine-checkable only) ----------
const testsPass = z.object({
    type: z.literal('tests_pass'),
    command: z.string().min(1).max(500),
    suite: z.string().max(200).optional(),
});
const artifactHash = z.object({
    type: z.literal('artifact_hash'),
    artifact_name: z.string().min(1).max(200),
    // hash supplied at claim time; here we pre-register that a hash will be produced
    hash_algo: z.literal('sha256').default('sha256'),
});
const metricThreshold = z.object({
    type: z.literal('metric_threshold'),
    metric: z.string().min(1).max(200),
    operator: z.enum(['gte', 'lte', 'gt', 'lt', 'eq']),
    threshold: z.number().finite(),
});
const counterpartySignoff = z.object({
    type: z.literal('counterparty_signoff'),
    description: z.string().min(10).max(500),
});
export const criteriaSchema = z.discriminatedUnion('type', [
    testsPass,
    artifactHash,
    metricThreshold,
    counterpartySignoff,
]);
// ---------- confidence-hedge rejection (§2, hard guardrail) ----------
const CONFIDENCE_KEYS = /confiden|probab|likelihood|chance|certainty|odds/i;
const HEDGE_PHRASES = /\b(try to|attempt to|hopefully|maybe|might|should be able|best effort|aim to|do my best|probably|i think|around \d+% (sure|confident)|\d+% (sure|confident|certain))\b/i;
function rejectConfidenceKeys(obj, path = '') {
    if (obj === null || typeof obj !== 'object')
        return null;
    for (const [key, val] of Object.entries(obj)) {
        if (CONFIDENCE_KEYS.test(key))
            return `${path}${key}`;
        const nested = rejectConfidenceKeys(val, `${path}${key}.`);
        if (nested)
            return nested;
    }
    return null;
}
// ---------- milestone & commitment schemas ----------
export const milestoneInputSchema = z
    .object({
    title: z.string().min(3).max(200),
    criteria: criteriaSchema,
    deadline: z.string().datetime({ offset: true }),
    budget_slice_usd: z.number().positive().finite(),
})
    .strict();
export const commitmentInputSchema = z
    .object({
    domain: z.string().min(2).max(100),
    goal: z.string().min(10).max(1000),
    deadline: z.string().datetime({ offset: true }), // absolute, required
    budget_cap_usd: z.number().positive().finite(), // required
    model_declared: z.string().min(2).max(100),
    counterparty_email: z.string().email(),
    visibility: z.enum(['public', 'category_only', 'hash_only']).default('category_only'),
    milestones: z.array(milestoneInputSchema).min(1).max(50),
})
    .strict(); // unknown keys (any smuggled confidence field) rejected by construction
export function validateCommitment(raw, now) {
    const errors = [];
    // 1. Confidence fields: unsubmittable, with a pointed error
    const confKey = rejectConfidenceKeys(raw);
    if (confKey) {
        return {
            ok: false,
            errors: [
                `Field "${confKey}" rejected. There is no confidence field on an oath — you swear it or you don't. ` +
                    `If you would attach a probability to this promise, you are not ready to promise. Decline aloud instead.`,
            ],
        };
    }
    // 2. Schema
    const parsed = commitmentInputSchema.safeParse(raw);
    if (!parsed.success) {
        return {
            ok: false,
            errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
        };
    }
    const c = parsed.data;
    // 3. Hedge language in goal/titles — "I promise to try" dies here
    for (const [where, text] of [
        ['goal', c.goal],
        ...c.milestones.map((m, i) => [`milestones[${i}].title`, m.title]),
    ]) {
        const hedge = text.match(HEDGE_PHRASES);
        if (hedge) {
            errors.push(`${where}: hedge language "${hedge[0]}" rejected. Swear a measurable outcome or do not swear.`);
        }
    }
    // 4. Deadlines: absolute, future, milestones within parent, monotonic
    const parentDeadline = new Date(c.deadline);
    if (parentDeadline <= now)
        errors.push('deadline: must be in the future');
    let prevDeadline = now;
    c.milestones.forEach((m, i) => {
        const d = new Date(m.deadline);
        if (d <= now)
            errors.push(`milestones[${i}].deadline: must be in the future`);
        if (d > parentDeadline)
            errors.push(`milestones[${i}].deadline: exceeds parent deadline`);
        if (d < prevDeadline)
            errors.push(`milestones[${i}].deadline: must not precede milestone ${i}'s predecessor (ordered path)`);
        prevDeadline = d;
    });
    // 5. Budget slices sum within cap
    const sliceSum = c.milestones.reduce((s, m) => s + m.budget_slice_usd, 0);
    if (sliceSum > c.budget_cap_usd + 1e-9) {
        errors.push(`milestones: budget slices sum to $${sliceSum.toFixed(2)}, exceeding cap $${c.budget_cap_usd.toFixed(2)}`);
    }
    if (errors.length)
        return { ok: false, errors };
    return { ok: true, errors: [], specificityGrade: gradeSpecificity(c), data: c };
}
/**
 * Vague-but-valid oaths wear a visible weakness grade.
 * A = tight; B = acceptable; C = weak (valid, but it shows).
 */
export function gradeSpecificity(c) {
    let score = 0;
    // Machine-checkable without human judgment scores higher
    const machineable = c.milestones.filter((m) => m.criteria.type !== 'counterparty_signoff').length;
    const ratio = machineable / c.milestones.length;
    if (ratio === 1)
        score += 2;
    else if (ratio >= 0.5)
        score += 1;
    // Concrete goal (numbers, artifacts, named things)
    if (/\d/.test(c.goal) || /[`"'][^`"']+[`"']/.test(c.goal))
        score += 1;
    // Decomposition: more than one milestone shows a thought-through path
    if (c.milestones.length >= 2)
        score += 1;
    // Short vague goal is weak
    if (c.goal.length < 40)
        score -= 1;
    if (score >= 3)
        return 'A';
    if (score >= 1)
        return 'B';
    return 'C';
}
// ---------- claim evidence (anti-distillation: no prose) ----------
const evidenceValue = z.union([
    z.object({ type: z.literal('tests_pass'), exit_code: z.number().int(), output_hash: z.string().regex(/^[0-9a-f]{64}$/) }),
    z.object({ type: z.literal('artifact_hash'), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
    z.object({ type: z.literal('metric_threshold'), measured_value: z.number().finite() }),
    z.object({ type: z.literal('counterparty_signoff') }), // resolves via the confirm link itself
]);
export const claimInputSchema = z
    .object({
    evidence: evidenceValue,
    actual_cost_usd: z.number().nonnegative().finite(),
    actual_duration_s: z.number().int().nonnegative(),
})
    .strict();
/** Evidence type must match the pre-registered criteria type. The frozen definition judges. */
export function evidenceMatchesCriteria(evidence, criteria) {
    if (evidence.type !== criteria.type) {
        return `evidence type "${evidence.type}" does not match pre-registered criteria "${criteria.type}"`;
    }
    if (criteria.type === 'metric_threshold' && evidence.type === 'metric_threshold') {
        const { operator, threshold } = criteria;
        const v = evidence.measured_value;
        const pass = operator === 'gte' ? v >= threshold :
            operator === 'lte' ? v <= threshold :
                operator === 'gt' ? v > threshold :
                    operator === 'lt' ? v < threshold :
                        v === threshold;
        if (!pass)
            return `measured value ${v} fails ${operator} ${threshold}`;
    }
    if (criteria.type === 'tests_pass' && evidence.type === 'tests_pass' && evidence.exit_code !== 0) {
        return `tests exited ${evidence.exit_code}`;
    }
    return null;
}
//# sourceMappingURL=guardrails.js.map