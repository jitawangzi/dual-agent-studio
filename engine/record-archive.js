/**
 * @file record-archive.js
 * @author shuyongqiang
 * @description Logical record group archiving and idempotent restoration (v2.14 Task 3).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { now, hash, atomicJson } = require('./run-store');
const { collectExportClosure } = require('./evidence-export');

const ARCHIVE_INDEX_FILE = 'archives/index.json';

function getArchivePath(store) {
    return path.join(store.root, ARCHIVE_INDEX_FILE);
}

function loadArchiveIndex(store) {
    const file = getArchivePath(store);
    if (!fs.existsSync(file)) {
        return { version: 1, updatedAt: now(), groups: [] };
    }
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!data || typeof data !== 'object' || !Array.isArray(data.groups)) {
            return { version: 1, updatedAt: now(), groups: [] };
        }
        return data;
    } catch {
        return { version: 1, updatedAt: now(), groups: [] };
    }
}

function saveArchiveIndex(store, index) {
    const file = getArchivePath(store);
    index.updatedAt = now();
    atomicJson(file, index);
}

/**
 * Returns a Set of "${kind}:${id}" that are currently logically archived.
 */
function getArchivedRecordSet(store) {
    const index = loadArchiveIndex(store);
    const set = new Set();
    for (const group of index.groups) {
        if (group.isArchived) {
            for (const ref of group.recordRefs || []) {
                set.add(`${ref.kind}:${ref.id}`);
            }
        }
    }
    return set;
}

/**
 * Previews an archive operation for a closed group of related records.
 */
function previewArchive(store, options = {}) {
    const { auditId } = options;
    if (!store || typeof store.read !== 'function') throw new Error('STORE_REQUIRED');
    if (typeof auditId !== 'string' || !/^[a-f0-9-]{36}$/.test(auditId)) throw new Error('INVALID_RECORD_ID');

    const blockers = [];

    if (store.guard && typeof store.guard.isBusy === 'function' && store.guard.isBusy()) {
        blockers.push('WORKFLOW_BUSY: A workflow is currently active; cannot archive records during execution');
    }

    const { records, omissions, rootAudit } = collectExportClosure(store, auditId);

    for (const r of records) {
        if (r.kind === 'runs' && ['RUNNING', 'TEST', 'DEV'].includes(r.record?.status)) {
            blockers.push(`ACTIVE_RUN_CONFLICT: Run '${r.id}' is actively executing (${r.record.status})`);
        }
        if (r.kind === 'audits' && ['RUNNING', 'CREATED'].includes(r.record?.status)) {
            blockers.push(`ACTIVE_AUDIT_CONFLICT: Audit '${r.id}' is actively running (${r.record.status})`);
        }
    }

    const recordRefs = records.map(r => ({ kind: r.kind, id: r.id }));

    // Deterministic version calculation
    const hasher = crypto.createHash('sha256');
    hasher.update(`archive|audit:${auditId}|`);
    for (const r of records) {
        hasher.update(`${r.kind}:${r.id}:${r.record.storageVersion || 0}:${r.record.updatedAt || ''};`);
    }
    const version = hasher.digest('hex');

    return {
        version,
        auditId,
        recordRefs,
        omissions,
        blockers
    };
}

/**
 * Applies logical archiving to an associated group of records.
 */
function applyArchive(store, options = {}) {
    const { version, auditId, note = '' } = options;
    const preview = previewArchive(store, { auditId });

    if (preview.blockers.length > 0) {
        throw new Error(`ARCHIVE_BLOCKED: ${preview.blockers.join('; ')}`);
    }

    if (version && preview.version !== version) {
        throw new Error('ARCHIVE_VERSION_CONFLICT: Source records have changed since archive was previewed');
    }

    const index = loadArchiveIndex(store);

    // Idempotent check: if an active archive group already covers this primary audit
    const existing = index.groups.find(g => g.primaryAuditId === auditId && g.isArchived);
    if (existing) {
        return existing;
    }

    const archiveId = crypto.randomUUID();
    const group = {
        id: archiveId,
        primaryAuditId: auditId,
        note: String(note).trim(),
        archivedAt: now(),
        restoredAt: null,
        isArchived: true,
        recordRefs: preview.recordRefs
    };

    index.groups.unshift(group);
    saveArchiveIndex(store, index);

    return group;
}

/**
 * Restores a logically archived group so its records reappear in default views.
 */
function restoreArchive(store, options = {}) {
    const { archiveId } = options;
    if (typeof archiveId !== 'string' || !/^[a-f0-9-]{36}$/.test(archiveId)) {
        throw new Error('INVALID_ARCHIVE_ID');
    }

    if (store.guard && typeof store.guard.isBusy === 'function' && store.guard.isBusy()) {
        throw new Error('WORKFLOW_BUSY: A workflow is currently active; cannot restore records during execution');
    }

    const index = loadArchiveIndex(store);
    const group = index.groups.find(g => g.id === archiveId);

    if (!group) {
        throw new Error(`ARCHIVE_NOT_FOUND: Archive group '${archiveId}' not found`);
    }

    if (!group.isArchived) {
        return group; // Already restored (idempotent)
    }

    group.isArchived = false;
    group.restoredAt = now();
    saveArchiveIndex(store, index);

    return group;
}

/**
 * Lists all archive groups.
 */
function listArchives(store) {
    const index = loadArchiveIndex(store);
    return index.groups;
}

module.exports = {
    getArchivedRecordSet,
    previewArchive,
    applyArchive,
    restoreArchive,
    listArchives
};
