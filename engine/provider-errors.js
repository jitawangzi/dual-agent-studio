'use strict';
/**
 * Provider Error Classification (2.11 Task 3).
 *
 * Classifies external CLI and model provider failures into actionable categories.
 * Only applied to actual failure signals; never applied to successful completions.
 *
 * @author shuyongqiang
 */

const ERROR_CODES = {
    AUTH_REQUIRED: 'AUTH_REQUIRED',
    MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
    RATE_LIMIT: 'RATE_LIMIT',
    QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',
    TIMEOUT: 'TIMEOUT',
    CLI_UPGRADE_REQUIRED: 'CLI_UPGRADE_REQUIRED',
    UNKNOWN: 'UNKNOWN'
};

function classifyProviderError(error) {
    if (!error) {
        return { code: ERROR_CODES.UNKNOWN, retryable: false, retryAfterSeconds: null, message: '' };
    }

    const message = String(error?.message || error?.stderr || error || '').trim();

    // 1. Upgrade required
    if (/requires a newer version|upgrade to the latest (app|CLI)/i.test(message)) {
        return { code: ERROR_CODES.CLI_UPGRADE_REQUIRED, retryable: false, retryAfterSeconds: null, message: message.slice(0, 500) };
    }

    // 2. Authentication & permissions
    if (/not logged in|unauthorized|authentication|invalid.api.key|sign in|auth required|api key missing|login required|token expired|credentials/i.test(message)) {
        return { code: ERROR_CODES.AUTH_REQUIRED, retryable: false, retryAfterSeconds: null, message: message.slice(0, 500) };
    }

    // 3. Model unavailable / unsupported
    if (/model.*(not found|not supported|not available|does not exist)|unsupported.*(model|effort|thinking)|unknown model/i.test(message)) {
        return { code: ERROR_CODES.MODEL_UNAVAILABLE, retryable: false, retryAfterSeconds: null, message: message.slice(0, 500) };
    }

    // 4. Rate limit (too many requests)
    if (/rate.limit|too many requests|429|resource exhausted.*rate/i.test(message)) {
        let retryAfter = null;
        const retryMatch = /(?:retry after|try again in)\s*(\d+)\s*(?:s|sec|seconds)?/i.exec(message);
        if (retryMatch) {
            const parsed = parseInt(retryMatch[1], 10);
            if (Number.isFinite(parsed) && parsed > 0) retryAfter = parsed;
        }
        return { code: ERROR_CODES.RATE_LIMIT, retryable: true, retryAfterSeconds: retryAfter, message: message.slice(0, 500) };
    }

    // 5. Quota / credits exhausted
    if (/quota|insufficient credits|exceeded your (current )?quota|billing|credit limit|insufficient balance/i.test(message)) {
        return { code: ERROR_CODES.QUOTA_EXHAUSTED, retryable: false, retryAfterSeconds: null, message: message.slice(0, 500) };
    }

    // 6. Timeout
    if (/timeout|timed out|EXECUTION_TIMEOUT/i.test(message)) {
        return { code: ERROR_CODES.TIMEOUT, retryable: true, retryAfterSeconds: null, message: message.slice(0, 500) };
    }

    return { code: ERROR_CODES.UNKNOWN, retryable: false, retryAfterSeconds: null, message: message.slice(0, 500) };
}

module.exports = {
    ERROR_CODES,
    classifyProviderError
};
