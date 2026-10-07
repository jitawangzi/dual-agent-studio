'use strict';
/**
 * 2.11 Task 3: Provider error classification unit tests.
 * @author shuyongqiang
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyProviderError, ERROR_CODES } = require('../engine/provider-errors');

test('classifyProviderError correctly classifies authentication and permission errors', () => {
    const errs = [
        'Error: You are not logged in. Please sign in.',
        'HTTP 401 Unauthorized: Invalid API key provided',
        'Authentication failed: api key missing or expired',
        'github copilot: credentials expired, login required'
    ];
    for (const msg of errs) {
        const c = classifyProviderError(new Error(msg));
        assert.equal(c.code, ERROR_CODES.AUTH_REQUIRED, `Expected AUTH_REQUIRED for: ${msg}`);
        assert.equal(c.retryable, false);
    }
});

test('classifyProviderError correctly classifies model unavailable errors', () => {
    const errs = [
        'Model gpt-5 is not supported for this provider',
        'The requested model does not exist',
        'unsupported thinking effort level: maximum',
        'Unknown model claude-3-ultra'
    ];
    for (const msg of errs) {
        const c = classifyProviderError(new Error(msg));
        assert.equal(c.code, ERROR_CODES.MODEL_UNAVAILABLE, `Expected MODEL_UNAVAILABLE for: ${msg}`);
        assert.equal(c.retryable, false);
    }
});

test('classifyProviderError correctly classifies quota and balance exhaustion', () => {
    const errs = [
        'You have exceeded your current quota. Please check your plan and billing details.',
        'Insufficient credits in your account',
        'Billing limit reached for this month',
        'insufficient balance to run this request'
    ];
    for (const msg of errs) {
        const c = classifyProviderError(new Error(msg));
        assert.equal(c.code, ERROR_CODES.QUOTA_EXHAUSTED, `Expected QUOTA_EXHAUSTED for: ${msg}`);
        assert.equal(c.retryable, false);
    }
});

test('classifyProviderError correctly classifies rate limits and extracts retry-after if available', () => {
    const r1 = classifyProviderError(new Error('Rate limit exceeded: 429 Too Many Requests'));
    assert.equal(r1.code, ERROR_CODES.RATE_LIMIT);
    assert.equal(r1.retryable, true);
    assert.equal(r1.retryAfterSeconds, null);

    const r2 = classifyProviderError(new Error('HTTP 429: Rate limit hit. Retry after 45 seconds'));
    assert.equal(r2.code, ERROR_CODES.RATE_LIMIT);
    assert.equal(r2.retryable, true);
    assert.equal(r2.retryAfterSeconds, 45);
});

test('classifyProviderError correctly classifies execution timeouts', () => {
    const errs = [
        'EXECUTION_TIMEOUT: process did not complete within 120s',
        'Request timed out waiting for server response'
    ];
    for (const msg of errs) {
        const c = classifyProviderError(new Error(msg));
        assert.equal(c.code, ERROR_CODES.TIMEOUT);
        assert.equal(c.retryable, true);
    }
});

test('classifyProviderError handles unknown errors and empty/null gracefully', () => {
    const r1 = classifyProviderError(new Error('syntax error in script.js line 4'));
    assert.equal(r1.code, ERROR_CODES.UNKNOWN);
    assert.equal(r1.retryable, false);

    const r2 = classifyProviderError(null);
    assert.equal(r2.code, ERROR_CODES.UNKNOWN);
    assert.equal(r2.retryable, false);
});
