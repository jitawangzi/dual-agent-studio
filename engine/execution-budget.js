'use strict';
/**
 * Execution Budget & Resource Accounting (2.11 Task 2).
 *
 * Provides concurrency-safe hard limits for attempt counts and active time.
 * All attempts (successful, failed, or malformed) count toward the budget.
 *
 * @author shuyongqiang
 */
const crypto = require('crypto');

const nowIso = (ms = Date.now()) => new Date(ms).toISOString();

function normalizeBudget(input) {
    if (input === undefined || input === null) {
        return { maxAttempts: null, maxActiveSeconds: null };
    }
    if (typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('INVALID_BUDGET: Budget must be an object');
    }
    const allowed = new Set(['maxAttempts', 'maxActiveSeconds']);
    for (const key of Object.keys(input)) {
        if (!allowed.has(key)) {
            throw new Error(`INVALID_BUDGET: Unknown budget property '${key}'`);
        }
    }
    let maxAttempts = null;
    if (input.maxAttempts !== undefined && input.maxAttempts !== null) {
        if (typeof input.maxAttempts !== 'number' || !Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 10000) {
            throw new Error('INVALID_BUDGET: maxAttempts must be an integer between 1 and 10000');
        }
        maxAttempts = input.maxAttempts;
    }
    let maxActiveSeconds = null;
    if (input.maxActiveSeconds !== undefined && input.maxActiveSeconds !== null) {
        if (typeof input.maxActiveSeconds !== 'number' || !Number.isInteger(input.maxActiveSeconds) || input.maxActiveSeconds < 1 || input.maxActiveSeconds > 86400) {
            throw new Error('INVALID_BUDGET: maxActiveSeconds must be an integer between 1 and 86400');
        }
        maxActiveSeconds = input.maxActiveSeconds;
    }
    return { maxAttempts, maxActiveSeconds };
}

function ensureBudget(record, initialBudget = null) {
    if (!record.budget || typeof record.budget !== 'object') {
        const limits = normalizeBudget(initialBudget);
        record.budget = {
            version: 1,
            limits,
            reservations: [],
            timeTracking: {
                totalActiveMs: 0,
                activeIntervals: [],
                lastCheckpointAt: null,
                uncertainActiveTime: false
            },
            adjustments: []
        };
    } else {
        if (!record.budget.limits) {
            record.budget.limits = { maxAttempts: null, maxActiveSeconds: null };
        }
        if (!Array.isArray(record.budget.reservations)) {
            record.budget.reservations = [];
        }
        if (!record.budget.timeTracking || typeof record.budget.timeTracking !== 'object') {
            record.budget.timeTracking = {
                totalActiveMs: 0,
                activeIntervals: [],
                lastCheckpointAt: null,
                uncertainActiveTime: false
            };
        }
        if (!Array.isArray(record.budget.adjustments)) {
            record.budget.adjustments = [];
        }
    }
    return record.budget;
}

function currentActiveSeconds(record, nowMs = Date.now()) {
    const b = ensureBudget(record);
    const tracking = b.timeTracking;
    let totalMs = tracking.totalActiveMs || 0;
    const open = tracking.activeIntervals?.find(i => i.stoppedAt === null);
    if (open) {
        const started = Date.parse(open.startedAt);
        if (Number.isFinite(started) && nowMs > started) {
            totalMs += (nowMs - started);
        }
    }
    return Math.floor(Math.max(0, totalMs) / 1000);
}

function startActiveTracking(record, { nowMs = Date.now() } = {}) {
    const b = ensureBudget(record);
    const tracking = b.timeTracking;
    tracking.activeIntervals = tracking.activeIntervals || [];
    let open = tracking.activeIntervals.find(i => i.stoppedAt === null);
    if (!open) {
        const iso = nowIso(nowMs);
        open = { startedAt: iso, stoppedAt: null, lastCheckpointAt: iso };
        tracking.activeIntervals.push(open);
        tracking.lastCheckpointAt = iso;
    } else {
        checkpointActiveTracking(record, { nowMs });
    }
    return open;
}

function checkpointActiveTracking(record, { nowMs = Date.now() } = {}) {
    const b = ensureBudget(record);
    const tracking = b.timeTracking;
    const iso = nowIso(nowMs);
    tracking.lastCheckpointAt = iso;
    const open = tracking.activeIntervals?.find(i => i.stoppedAt === null);
    if (open) {
        open.lastCheckpointAt = iso;
    }
}

function stopActiveTracking(record, { nowMs = Date.now() } = {}) {
    const b = ensureBudget(record);
    const tracking = b.timeTracking;
    const iso = nowIso(nowMs);
    tracking.lastCheckpointAt = iso;
    const open = tracking.activeIntervals?.find(i => i.stoppedAt === null);
    if (open) {
        open.stoppedAt = iso;
        open.lastCheckpointAt = iso;
        const duration = Math.max(0, nowMs - Date.parse(open.startedAt));
        tracking.totalActiveMs = (tracking.totalActiveMs || 0) + duration;
    }
}

function remainingBudget(record, nowMs = Date.now()) {
    const b = ensureBudget(record);
    const { maxAttempts, maxActiveSeconds } = b.limits;

    const activeReservations = b.reservations.filter(r => r.status === 'RESERVED' || r.status === 'STARTED');
    const settledReservations = b.reservations.filter(r => r.status === 'SETTLED');

    const usedAttempts = settledReservations.length;
    const reservedAttempts = activeReservations.length;
    const totalConsumed = usedAttempts + reservedAttempts;

    let remainingAttempts = null;
    let attemptsExhausted = false;
    if (maxAttempts !== null) {
        remainingAttempts = Math.max(0, maxAttempts - totalConsumed);
        if (remainingAttempts === 0) attemptsExhausted = true;
    }

    const activeSec = currentActiveSeconds(record, nowMs);
    let remainingActiveSeconds = null;
    let timeExhausted = false;
    if (maxActiveSeconds !== null) {
        remainingActiveSeconds = Math.max(0, maxActiveSeconds - activeSec);
        if (remainingActiveSeconds === 0) timeExhausted = true;
    }

    const exhausted = attemptsExhausted || timeExhausted;
    let reason = null;
    if (attemptsExhausted && timeExhausted) reason = 'MAX_ATTEMPTS_AND_TIME_EXCEEDED';
    else if (attemptsExhausted) reason = 'MAX_ATTEMPTS_EXCEEDED';
    else if (timeExhausted) reason = 'MAX_ACTIVE_SECONDS_EXCEEDED';

    const allowedActions = exhausted ? ['INCREASE_BUDGET', 'MANUAL_RESUME'] : [];

    return {
        maxAttempts,
        usedAttempts,
        reservedAttempts,
        remainingAttempts,
        maxActiveSeconds,
        activeSeconds: activeSec,
        remainingActiveSeconds,
        uncertainActiveTime: Boolean(b.timeTracking.uncertainActiveTime),
        exhausted,
        reason,
        allowedActions
    };
}

function reserveAttempt(record, { stepId, nowMs = Date.now() } = {}) {
    if (!stepId) throw new Error('RESERVATION_STEP_REQUIRED');
    const b = ensureBudget(record);
    const current = remainingBudget(record, nowMs);
    if (current.exhausted) {
        const err = new Error(`BUDGET_EXHAUSTED: ${current.reason}`);
        err.code = 'BUDGET_EXHAUSTED';
        err.reason = current.reason;
        err.allowedActions = current.allowedActions;
        throw err;
    }

    const reservation = {
        id: crypto.randomUUID(),
        stepId: String(stepId),
        status: 'RESERVED',
        reservedAt: nowIso(nowMs),
        startedAt: null,
        settledAt: null,
        cancelledAt: null,
        outcome: null,
        reason: null
    };
    b.reservations.push(reservation);
    return reservation.id;
}

function markAttemptStarted(record, reservationId, { nowMs = Date.now() } = {}) {
    const b = ensureBudget(record);
    const reservation = b.reservations.find(r => r.id === reservationId);
    if (!reservation) throw new Error('UNKNOWN_RESERVATION_ID');
    if (reservation.status === 'STARTED') return false;
    if (reservation.status !== 'RESERVED') throw new Error(`INVALID_RESERVATION_STATE: ${reservation.status}`);
    reservation.status = 'STARTED';
    reservation.startedAt = nowIso(nowMs);
    return true;
}

function settleAttempt(record, reservationId, outcome = {}, { nowMs = Date.now() } = {}) {
    const b = ensureBudget(record);
    const reservation = b.reservations.find(r => r.id === reservationId);
    if (!reservation) throw new Error('UNKNOWN_RESERVATION_ID');
    if (reservation.status === 'SETTLED') return false;
    if (reservation.status === 'CANCELLED') throw new Error('RESERVATION_ALREADY_CANCELLED');
    reservation.status = 'SETTLED';
    reservation.settledAt = nowIso(nowMs);
    reservation.outcome = outcome;
    return true;
}

function cancelReservation(record, reservationId, { reason = 'CANCELLED', nowMs = Date.now() } = {}) {
    const b = ensureBudget(record);
    const reservation = b.reservations.find(r => r.id === reservationId);
    if (!reservation) throw new Error('UNKNOWN_RESERVATION_ID');
    if (reservation.status === 'STARTED') {
        throw new Error('CANNOT_CANCEL_STARTED_RESERVATION: Started attempts must be settled');
    }
    if (reservation.status === 'SETTLED') throw new Error('RESERVATION_ALREADY_SETTLED');
    if (reservation.status === 'CANCELLED') return false;
    reservation.status = 'CANCELLED';
    reservation.cancelledAt = nowIso(nowMs);
    reservation.reason = String(reason);
    return true;
}

function adjustBudget(record, newBudgetInput, { reason, nowMs = Date.now() } = {}) {
    if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 10000) {
        throw new Error('INVALID_BUDGET_REASON: Reason must be 1-10000 characters');
    }
    const b = ensureBudget(record);
    const newLimits = normalizeBudget(newBudgetInput);
    const current = remainingBudget(record, nowMs);

    if (newLimits.maxAttempts !== null && newLimits.maxAttempts < current.usedAttempts) {
        throw new Error('INVALID_BUDGET: New maxAttempts cannot be less than already used attempts');
    }
    if (newLimits.maxActiveSeconds !== null && newLimits.maxActiveSeconds < current.activeSeconds) {
        throw new Error('INVALID_BUDGET: New maxActiveSeconds cannot be less than already accumulated active seconds');
    }

    b.adjustments.push({
        at: nowIso(nowMs),
        previousLimits: { ...b.limits },
        newLimits: { ...newLimits },
        reason: reason.trim()
    });
    b.limits = newLimits;
    return b.limits;
}

function recoverBudget(record, { nowMs = Date.now() } = {}) {
    const b = ensureBudget(record);
    let changed = false;
    for (const r of b.reservations) {
        if (r.status === 'STARTED') {
            r.status = 'SETTLED';
            r.settledAt = nowIso(nowMs);
            r.outcome = { status: 'INTERRUPTED', errorCode: 'SERVICE_RESTARTED' };
            changed = true;
        } else if (r.status === 'RESERVED') {
            r.status = 'CANCELLED';
            r.cancelledAt = nowIso(nowMs);
            r.reason = 'SERVICE_RESTARTED_BEFORE_START';
            changed = true;
        }
    }
    const intervals = b.timeTracking.activeIntervals;
    const openInterval = intervals?.find(i => i.stoppedAt === null);
    if (openInterval) {
        const stopTime = openInterval.lastCheckpointAt || openInterval.startedAt;
        openInterval.stoppedAt = stopTime;
        const duration = Math.max(0, Date.parse(stopTime) - Date.parse(openInterval.startedAt));
        b.timeTracking.totalActiveMs = (b.timeTracking.totalActiveMs || 0) + duration;
        b.timeTracking.uncertainActiveTime = true;
        changed = true;
    }
    return changed;
}

module.exports = {
    normalizeBudget,
    ensureBudget,
    reserveAttempt,
    markAttemptStarted,
    settleAttempt,
    cancelReservation,
    remainingBudget,
    adjustBudget,
    startActiveTracking,
    checkpointActiveTracking,
    stopActiveTracking,
    recoverBudget,
    currentActiveSeconds
};
