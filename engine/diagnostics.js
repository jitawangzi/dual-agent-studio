/**
 * @file diagnostics.js
 * @author shuyongqiang
 * @description System diagnostic package generator and storage overview scanner (v2.14 Task 4).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { planMigration } = require('./storage-migration');
const { listArchives, getArchivedRecordSet } = require('./record-archive');
const { CURRENT_STORAGE_VERSION, validateRecord } = require('./storage-schema');

const KINDS = ['runs', 'plans', 'audits', 'discussions', 'decision-cases'];

/**
 * Recursively computes directory size and file count safely.
 */
function getDirStats(dirPath) {
    let bytes = 0;
    let fileCount = 0;
    if (!fs.existsSync(dirPath)) return { bytes, fileCount };

    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                const sub = getDirStats(full);
                bytes += sub.bytes;
                fileCount += sub.fileCount;
            } else if (entry.isFile()) {
                try {
                    const stat = fs.statSync(full);
                    bytes += stat.size;
                    fileCount++;
                } catch {}
            }
        }
    } catch {}
    return { bytes, fileCount };
}

/**
 * Computes an aggregated overview of storage metrics.
 */
function getStorageOverview(store) {
    if (!store || typeof store.root !== 'string') throw new Error('STORE_REQUIRED');

    const archivedSet = getArchivedRecordSet(store);
    const byKind = {};
    let totalRecords = 0;
    let totalCorrupted = 0;
    let totalFutureVersion = 0;
    let totalArchived = 0;
    let totalAttachmentFiles = 0;
    let totalAttachmentBytes = 0;

    for (const kind of KINDS) {
        const diag = store.listWithDiagnostics(kind);
        const records = diag.records || [];
        const errors = diag.errors || [];

        let kindAttachmentFiles = 0;
        let kindAttachmentBytes = 0;
        let kindArchived = 0;

        const kindDir = path.join(store.root, kind);
        if (fs.existsSync(kindDir)) {
            try {
                const ids = fs.readdirSync(kindDir);
                for (const id of ids) {
                    const recDir = path.join(kindDir, id);
                    if (fs.existsSync(recDir) && fs.statSync(recDir).isDirectory()) {
                        const files = fs.readdirSync(recDir);
                        for (const f of files) {
                            if (f.toLowerCase() !== 'state.json') {
                                try {
                                    const stat = fs.statSync(path.join(recDir, f));
                                    kindAttachmentFiles++;
                                    kindAttachmentBytes += stat.size;
                                } catch {}
                            }
                        }
                    }
                    if (archivedSet.has(`${kind}:${id}`)) {
                        kindArchived++;
                    }
                }
            } catch {}
        }

        const futureErrors = errors.filter(e => e.code === 'UNSUPPORTED_STORAGE_VERSION').length;
        const corruptedErrors = errors.length - futureErrors;

        byKind[kind] = {
            validCount: records.length,
            corruptedCount: corruptedErrors,
            futureVersionCount: futureErrors,
            archivedCount: kindArchived,
            attachmentFiles: kindAttachmentFiles,
            attachmentBytes: kindAttachmentBytes
        };

        totalRecords += records.length;
        totalCorrupted += corruptedErrors;
        totalFutureVersion += futureErrors;
        totalArchived += kindArchived;
        totalAttachmentFiles += kindAttachmentFiles;
        totalAttachmentBytes += kindAttachmentBytes;
    }

    const migrationPlan = planMigration(store);
    const archiveGroups = listArchives(store);
    const totalDirStats = getDirStats(store.root);

    return {
        scannedAt: new Date().toISOString(),
        currentStorageVersion: CURRENT_STORAGE_VERSION,
        summary: {
            totalRecords,
            totalCorrupted,
            totalFutureVersion,
            totalArchived,
            totalAttachmentFiles,
            totalAttachmentBytes,
            totalStoreBytes: totalDirStats.bytes,
            totalStoreFiles: totalDirStats.fileCount
        },
        byKind,
        migration: {
            pendingMigrationCount: migrationPlan.entries.length,
            batchVersion: migrationPlan.version
        },
        archiveGroupsCount: archiveGroups.length,
        activeArchiveGroupsCount: archiveGroups.filter(g => g.isArchived).length
    };
}

/**
 * Generates a sanitized diagnostic package containing runtime environment and storage metrics.
 * Explicitly excludes environment variable values, API tokens, cookie data, and repository source code.
 */
function buildDiagnosticPackage(store, options = {}) {
    if (!store || typeof store.root !== 'string') throw new Error('STORE_REQUIRED');

    const overview = getStorageOverview(store);

    let activeLockInfo = null;
    const lockFile = path.join(store.root, 'instance.lock');
    if (fs.existsSync(lockFile)) {
        try {
            const data = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
            activeLockInfo = {
                pid: data.pid,
                acquiredAt: data.acquiredAt,
                kind: data.owner?.kind || null
            };
        } catch {}
    }

    return {
        formatVersion: 1,
        generatedAt: new Date().toISOString(),
        system: {
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
            osRelease: os.release(),
            appUptimeSeconds: Math.floor(process.uptime()),
            memoryUsage: process.memoryUsage()
        },
        storage: overview,
        activeLock: activeLockInfo,
        redactionNotice: 'Sanitized diagnostic report. Environment variable secrets, authorization tokens, network cookies, and source code files are strictly excluded.'
    };
}

module.exports = {
    getStorageOverview,
    buildDiagnosticPackage
};
