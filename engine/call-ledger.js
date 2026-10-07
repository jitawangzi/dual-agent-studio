'use strict';
/**
 * Unified agent call ledger (2.11 Task 1).
 *
 * Records one attempt per real provider invocation on the owning workflow record
 * (record.callLedger.attempts). Only metadata is stored; prompts and answers stay
 * in the existing artifacts. Unknown token/cost data is always null — usage is
 * trusted only when an explicit provider adapter marks it source:'PROVIDER'.
 *
 * @author shuyongqiang
 */
const crypto = require('crypto');

const FINAL_STATUSES = new Set(['COMPLETED', 'CALL_FAILED', 'INVALID_RESPONSE', 'TIMED_OUT', 'STOPPED', 'INTERRUPTED', 'DISCARDED']);
const FAILED_STATUSES = new Set(['CALL_FAILED', 'INVALID_RESPONSE', 'TIMED_OUT']);
const INTERRUPTED_STATUSES = new Set(['STOPPED', 'INTERRUPTED']);

const nowIso = () => new Date().toISOString();
const text = (value, max = 200) => (value === undefined || value === null ? '' : String(value).slice(0, max));

function emptyUsage() {
    return { inputTokens: null, outputTokens: null, cost: null, currency: null, source: 'UNKNOWN' };
}

function normalizeUsage(usage) {
    if (!usage || typeof usage !== 'object' || usage.source !== 'PROVIDER') return emptyUsage();
    const num = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
    const result = {
        inputTokens: num(usage.inputTokens),
        outputTokens: num(usage.outputTokens),
        cost: num(usage.cost),
        currency: typeof usage.currency === 'string' && /^[A-Z]{3}$/.test(usage.currency) ? usage.currency : null,
        source: 'PROVIDER'
    };
    if (result.cost === null || result.currency === null) { result.cost = null; result.currency = null; }
    return result;
}

function ledger(record) {
    if (!record.callLedger || typeof record.callLedger !== 'object' || !Array.isArray(record.callLedger.attempts)) {
        record.callLedger = { version: 1, attempts: [] };
    }
    return record.callLedger;
}

function findAttempt(record, attemptId) {
    const attempt = record.callLedger?.attempts?.find(a => a.id === attemptId);
    if (!attempt) throw new Error('UNKNOWN_CALL_ATTEMPT');
    return attempt;
}

/** Registers a new attempt. Every real invocation (including retries) gets a new id. */
function beginAttempt(record, meta = {}) {
    if (!meta.stepId) throw new Error('CALL_STEP_REQUIRED');
    if (!meta.role) throw new Error('CALL_ROLE_REQUIRED');
    const provider = text(meta.provider) || 'unknown';
    const attempt = {
        id: crypto.randomUUID(),
        stepId: text(meta.stepId),
        role: text(meta.role),
        phase: meta.phase ? text(meta.phase) : null,
        childId: meta.childId ? text(meta.childId) : null,
        provider,
        model: text(meta.model),
        reasoningEffort: text(meta.reasoningEffort),
        sessionId: text(meta.sessionId),
        billable: provider !== 'mock',
        status: 'RUNNING',
        startedAt: meta.startedAt || nowIso(),
        respondedAt: null,
        finishedAt: null,
        durationMs: null,
        errorCode: null,
        usage: emptyUsage()
    };
    ledger(record).attempts.push(attempt);
    return attempt.id;
}

/** Notes that provider output was received (before validation). */
function markResponded(record, attemptId, { at } = {}) {
    const attempt = findAttempt(record, attemptId);
    if (attempt.status !== 'RUNNING' || attempt.respondedAt) return false;
    attempt.respondedAt = at || nowIso();
    return true;
}

/** Settles an attempt exactly once. Repeated callbacks return false and change nothing. */
function finishAttempt(record, attemptId, { status, finishedAt, errorCode, usage } = {}) {
    const attempt = findAttempt(record, attemptId);
    if (!FINAL_STATUSES.has(status)) throw new Error('INVALID_CALL_STATUS');
    if (attempt.status !== 'RUNNING') return false;
    attempt.status = status;
    attempt.finishedAt = finishedAt || nowIso();
    const duration = Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt);
    attempt.durationMs = Number.isFinite(duration) ? Math.max(0, duration) : null;
    attempt.errorCode = errorCode ? text(errorCode, 80) : null;
    attempt.usage = normalizeUsage(usage);
    return true;
}

/** Restart recovery: open attempts keep their consumption and become INTERRUPTED. */
function interruptOpenAttempts(record, { at, errorCode = 'SERVICE_RESTARTED' } = {}) {
    let count = 0;
    for (const attempt of record?.callLedger?.attempts || []) {
        if (attempt.status === 'RUNNING' && finishAttempt(record, attempt.id, { status: 'INTERRUPTED', finishedAt: at, errorCode })) count++;
    }
    return count;
}

function summarizeUsage(attempts) {
    const settled = attempts.filter(a => a.status !== 'RUNNING');
    if (!settled.length) return emptyUsage();
    const usages = settled.map(a => a.usage || emptyUsage());
    const allProvider = usages.every(u => u.source === 'PROVIDER');
    const sum = key => (usages.every(u => typeof u[key] === 'number') ? usages.reduce((n, u) => n + u[key], 0) : null);
    const currencies = new Set(usages.map(u => u.currency));
    const cost = currencies.size === 1 && !currencies.has(null) ? sum('cost') : null;
    return {
        inputTokens: allProvider ? sum('inputTokens') : null,
        outputTokens: allProvider ? sum('outputTokens') : null,
        cost: allProvider ? cost : null,
        currency: allProvider && cost !== null ? [...currencies][0] : null,
        source: allProvider ? 'PROVIDER' : 'UNKNOWN'
    };
}

function summarizeCalls(record) {
    const hasLedger = Array.isArray(record?.callLedger?.attempts);
    const attempts = hasLedger ? record.callLedger.attempts : [];
    const count = predicate => attempts.filter(predicate).length;
    return {
        attempts: attempts.length,
        completed: count(a => a.status === 'COMPLETED'),
        failed: count(a => FAILED_STATUSES.has(a.status)),
        interrupted: count(a => INTERRUPTED_STATUSES.has(a.status)),
        discarded: count(a => a.status === 'DISCARDED'),
        running: count(a => a.status === 'RUNNING'),
        billable: count(a => a.billable !== false),
        mock: count(a => a.billable === false),
        durationMs: attempts.reduce((n, a) => n + (typeof a.durationMs === 'number' ? a.durationMs : 0), 0),
        usage: summarizeUsage(attempts),
        legacy: !hasLedger
    };
}

function errorCodeOf(error, fallback) {
    const match = /^([A-Z][A-Z0-9_]{2,})/.exec(String(error?.message || ''));
    return match ? match[1] : fallback;
}

/**
 * Wraps a provider call with ledger lifecycle checkpoints:
 * persisted before the provider, after output is received, and after validation.
 * `accept` performs post-output checks/parsing; its failure means INVALID_RESPONSE
 * (or DISCARDED when the source changed, STOPPED when cancelled).
 */
const { reserveAttempt, markAttemptStarted, settleAttempt, remainingBudget } = require('./execution-budget');

async function trackedCall(record, meta, { persist = () => {}, invoke, accept = value => value, signal } = {}) {
    let reservationId = null;
    let budgetTimeoutMs = null;
    if (record.budget) {
        reservationId = reserveAttempt(record, { stepId: meta.stepId });
        persist();
        const curBudget = remainingBudget(record);
        if (curBudget.remainingActiveSeconds !== null) {
            budgetTimeoutMs = Math.max(0, curBudget.remainingActiveSeconds * 1000);
        }
    }
    const attemptId = beginAttempt(record, meta);
    persist();
    const invocationController = new AbortController();
    let budgetTimer = null;
    let budgetExhaustedError = null;
    let onExternalAbort = null;

    if (signal) {
        if (signal.aborted) {
            invocationController.abort(signal.reason || new Error('RUN_CANCELLED'));
        } else {
            onExternalAbort = () => {
                invocationController.abort(signal.reason || new Error('RUN_CANCELLED'));
            };
            signal.addEventListener('abort', onExternalAbort, { once: true });
        }
    }

    if (budgetTimeoutMs !== null) {
        if (budgetTimeoutMs <= 0) {
            budgetExhaustedError = new Error('BUDGET_EXHAUSTED: MAX_ACTIVE_SECONDS_EXCEEDED');
            budgetExhaustedError.code = 'BUDGET_EXHAUSTED';
            invocationController.abort(budgetExhaustedError);
        } else {
            budgetTimer = setTimeout(() => {
                budgetExhaustedError = new Error('BUDGET_EXHAUSTED: MAX_ACTIVE_SECONDS_EXCEEDED');
                budgetExhaustedError.code = 'BUDGET_EXHAUSTED';
                invocationController.abort(budgetExhaustedError);
            }, budgetTimeoutMs);
        }
    }

    let answer;
    try {
        if (reservationId) {
            markAttemptStarted(record, reservationId);
            persist();
        }
        let rawAnswer;
        let invokeError = null;
        try {
            rawAnswer = await invoke(attemptId, invocationController.signal);
        } catch (err) {
            invokeError = err;
        } finally {
            if (budgetTimer) clearTimeout(budgetTimer);
            if (signal && onExternalAbort) signal.removeEventListener('abort', onExternalAbort);
        }

        if (budgetExhaustedError) {
            throw budgetExhaustedError;
        }
        if (signal?.aborted) {
            throw (signal.reason || new Error('RUN_CANCELLED'));
        }
        if (invocationController.signal.aborted && invocationController.signal.reason) {
            throw invocationController.signal.reason;
        }
        if (invokeError) {
            throw invokeError;
        }
        answer = rawAnswer;
    } catch (error) {
        const message = String(error?.message || '');
        const isBudget = error?.code === 'BUDGET_EXHAUSTED' || /BUDGET_EXHAUSTED/.test(message);
        const status = isBudget ? 'STOPPED' : signal?.aborted || /RUN_CANCELLED/.test(message) ? 'STOPPED' : /TIMEOUT/.test(message) ? 'TIMED_OUT' : 'CALL_FAILED';
        finishAttempt(record, attemptId, { status, errorCode: isBudget ? 'BUDGET_EXHAUSTED' : errorCodeOf(error, status) });
        if (reservationId) {
            settleAttempt(record, reservationId, { status, attemptId, errorCode: isBudget ? 'BUDGET_EXHAUSTED' : errorCodeOf(error, status) });
        }
        persist();
        throw error;
    }
    markResponded(record, attemptId);
    persist();
    try {
        const result = await accept(answer);
        if (record.budget) {
            const postBudget = remainingBudget(record);
            if (postBudget.remainingActiveSeconds === 0) {
                const err = new Error('BUDGET_EXHAUSTED: MAX_ACTIVE_SECONDS_EXCEEDED');
                err.code = 'BUDGET_EXHAUSTED';
                finishAttempt(record, attemptId, { status: 'STOPPED', errorCode: 'BUDGET_EXHAUSTED' });
                if (reservationId) {
                    settleAttempt(record, reservationId, { status: 'STOPPED', attemptId, errorCode: 'BUDGET_EXHAUSTED' });
                }
                persist();
                throw err;
            }
        }
        finishAttempt(record, attemptId, { status: 'COMPLETED', usage: meta.usage });
        if (reservationId) {
            settleAttempt(record, reservationId, { status: 'COMPLETED', attemptId });
        }
        persist();
        return result;
    } catch (error) {
        const message = String(error?.message || '');
        const isBudget = error?.code === 'BUDGET_EXHAUSTED' || /BUDGET_EXHAUSTED/.test(message);
        const status = isBudget ? 'STOPPED' : signal?.aborted || /RUN_CANCELLED/.test(message) ? 'STOPPED' : /SOURCE_CHANGED/.test(message) ? 'DISCARDED' : 'INVALID_RESPONSE';
        finishAttempt(record, attemptId, { status, errorCode: isBudget ? 'BUDGET_EXHAUSTED' : status === 'INVALID_RESPONSE' ? 'INVALID_RESPONSE' : errorCodeOf(error, status) });
        if (reservationId) {
            settleAttempt(record, reservationId, { status, attemptId, errorCode: isBudget ? 'BUDGET_EXHAUSTED' : status === 'INVALID_RESPONSE' ? 'INVALID_RESPONSE' : errorCodeOf(error, status) });
        }
        persist();
        throw error;
    }
}

module.exports = {
    beginAttempt,
    markResponded,
    finishAttempt,
    interruptOpenAttempts,
    summarizeCalls,
    normalizeUsage,
    trackedCall,
    FINAL_STATUSES
};
