'use strict';

const CURRENT_STORAGE_VERSION = 1;

function normalizeRecord(kind, raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('INVALID_RECORD_FORMAT');
    }
    const version = raw.storageVersion;
    if (version !== undefined && version !== null) {
        if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
            throw new Error('INVALID_STORAGE_VERSION');
        }
        if (version > CURRENT_STORAGE_VERSION) {
            throw new Error('UNSUPPORTED_STORAGE_VERSION');
        }
    }
    const normalized = {
        ...raw,
        storageVersion: version ?? 0
    };
    if (kind === 'audits') {
        normalized.findings = Array.isArray(raw.findings) ? raw.findings : (raw.findings ?? []);
        normalized.reviewers = Array.isArray(raw.reviewers) ? raw.reviewers : (raw.reviewers ?? []);
    }
    return normalized;
}

function validateRecord(kind, raw, expectedId = null) {
    const errors = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, errors: [{ path: '', code: 'NOT_AN_OBJECT' }] };
    }
    if (typeof raw.id !== 'string' || !/^[a-f0-9-]{36}$/.test(raw.id)) {
        errors.push({ path: 'id', code: 'INVALID_OR_MISSING_ID' });
    } else if (expectedId && raw.id !== expectedId) {
        errors.push({ path: 'id', code: 'ID_MISMATCH' });
    }
    const hasWsKey = typeof raw.workspaceKey === 'string' && raw.workspaceKey.trim().length > 0;
    const hasWsRoot = typeof raw.workspaceRoot === 'string' && raw.workspaceRoot.trim().length > 0;
    if (!hasWsKey && !hasWsRoot) {
        errors.push({ path: 'workspaceKey', code: 'MISSING_WORKSPACE' });
    }
    if (raw.findings !== undefined && !Array.isArray(raw.findings)) {
        errors.push({ path: 'findings', code: 'INVALID_FINDINGS' });
    }
    if (raw.reviewers !== undefined && !Array.isArray(raw.reviewers)) {
        errors.push({ path: 'reviewers', code: 'INVALID_REVIEWERS' });
    }
    if (raw.updatedAt !== undefined && raw.updatedAt !== null && typeof raw.updatedAt !== 'string') {
        errors.push({ path: 'updatedAt', code: 'INVALID_UPDATED_AT' });
    }
    if (raw.createdAt !== undefined && raw.createdAt !== null && typeof raw.createdAt !== 'string') {
        errors.push({ path: 'createdAt', code: 'INVALID_CREATED_AT' });
    }
    if (raw.storageVersion !== undefined && raw.storageVersion !== null) {
        if (typeof raw.storageVersion !== 'number' || raw.storageVersion < 0 || raw.storageVersion > CURRENT_STORAGE_VERSION) {
            errors.push({ path: 'storageVersion', code: 'INVALID_OR_UNSUPPORTED_STORAGE_VERSION' });
        }
    }
    return { ok: errors.length === 0, errors };
}

module.exports = {
    CURRENT_STORAGE_VERSION,
    normalizeRecord,
    validateRecord
};
