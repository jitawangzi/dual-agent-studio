'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CURRENT_STORAGE_VERSION, validateRecord } = require('./storage-schema');
const { hash, now, atomicJson } = require('./run-store');

const KINDS = ['runs', 'plans', 'audits', 'discussions'];

function recordsMatchExceptVersion(rec, backupRec, targetVersion) {
    if (!rec || !backupRec || typeof rec !== 'object' || typeof backupRec !== 'object') return false;
    if (rec.storageVersion !== targetVersion) return false;

    const ignored = new Set(['storageVersion', 'updatedAt']);
    const recKeys = Object.keys(rec).filter(k => !ignored.has(k)).sort();
    const backupKeys = Object.keys(backupRec).filter(k => !ignored.has(k)).sort();

    if (recKeys.length !== backupKeys.length) return false;
    for (let i = 0; i < recKeys.length; i++) {
        const k = recKeys[i];
        if (k !== backupKeys[i]) return false;
        if (JSON.stringify(rec[k]) !== JSON.stringify(backupRec[k])) return false;
    }
    return true;
}

function inspectBackups(store) {
    const backupsDir = path.join(store.root, 'backups');
    if (!fs.existsSync(backupsDir)) return { inProgress: null, corrupted: [], activeOperationId: null };
    const entries = fs.readdirSync(backupsDir);
    let inProgress = null;
    const corrupted = [];
    let activeOperationId = null;

    for (const dirName of entries) {
        const journalPath = path.join(backupsDir, dirName, 'journal.json');
        if (!fs.existsSync(journalPath)) continue;
        try {
            const raw = fs.readFileSync(journalPath, 'utf8');
            const j = JSON.parse(raw);
            if (!j || typeof j !== 'object' || Array.isArray(j) || !Array.isArray(j.entries)) {
                corrupted.push({
                    kind: 'maintenance',
                    id: dirName,
                    path: journalPath,
                    code: 'CORRUPTED_JOURNAL',
                    message: `Migration journal in backup ${dirName} has invalid structure`
                });
                if (!activeOperationId) activeOperationId = dirName;
                continue;
            }
            if (j.status === 'IN_PROGRESS') {
                inProgress = {
                    journal: j,
                    journalPath,
                    backupDir: path.join(backupsDir, dirName)
                };
                activeOperationId = j.operationId || dirName;
            }
        } catch (err) {
            corrupted.push({
                kind: 'maintenance',
                id: dirName,
                path: journalPath,
                code: 'CORRUPTED_JOURNAL',
                message: `Migration journal in backup ${dirName} is corrupted or truncated: ${err.message}`
            });
            if (!activeOperationId) activeOperationId = dirName;
        }
    }
    return { inProgress, corrupted, activeOperationId };
}

function findInProgressJournal(store) {
    return inspectBackups(store).inProgress;
}

function planMigration(store) {
    const entries = [];
    const errors = [];

    for (const kind of KINDS) {
        const dir = path.join(store.root, kind);
        if (!fs.existsSync(dir)) continue;

        for (const id of fs.readdirSync(dir)) {
            let file;
            try {
                file = store.file(kind, id);
            } catch (err) {
                errors.push({ kind, id, code: 'INVALID_RECORD_ID', message: err.message });
                continue;
            }

            if (!fs.existsSync(file)) continue;

            let rawText;
            let rawObj;
            try {
                rawText = fs.readFileSync(file, 'utf8');
                rawObj = JSON.parse(rawText);
            } catch (err) {
                errors.push({ kind, id, path: file, code: 'CORRUPTED_RECORD', message: err.message });
                continue;
            }

            if (!rawObj || typeof rawObj !== 'object' || Array.isArray(rawObj)) {
                errors.push({ kind, id, path: file, code: 'CORRUPTED_RECORD_STRUCTURE', message: 'Record is not an object' });
                continue;
            }

            const currentVersion = rawObj.storageVersion ?? 0;
            if (currentVersion > CURRENT_STORAGE_VERSION) {
                errors.push({ kind, id, path: file, code: 'UNSUPPORTED_STORAGE_VERSION', message: `storageVersion ${currentVersion} > ${CURRENT_STORAGE_VERSION}` });
                continue;
            }

            const validation = validateRecord(kind, rawObj, id);
            if (!validation.ok) {
                errors.push({
                    kind,
                    id,
                    path: file,
                    code: 'CORRUPTED_RECORD_STRUCTURE',
                    message: `Record structure invalid: ${validation.errors.map(e => e.code).join(', ')}`
                });
                continue;
            }

            if (currentVersion < CURRENT_STORAGE_VERSION) {
                const beforeHash = hash(rawText);
                entries.push({
                    kind,
                    id,
                    file,
                    beforeHash,
                    from: currentVersion,
                    to: CURRENT_STORAGE_VERSION
                });
            }
        }
    }

    entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    const version = hash(JSON.stringify(entries.map(e => ({ kind: e.kind, id: e.id, beforeHash: e.beforeHash, from: e.from, to: e.to }))));

    const { inProgress, corrupted, activeOperationId } = inspectBackups(store);
    errors.push(...corrupted);

    return {
        version,
        targetVersion: CURRENT_STORAGE_VERSION,
        entries,
        errors,
        activeOperationId: inProgress ? inProgress.journal.operationId : (activeOperationId || null)
    };
}

function applyMigration(store, { version, operationId } = {}) {
    if (!version || typeof version !== 'string') {
        throw new Error('VERSION_REQUIRED');
    }

    const { inProgress, corrupted, activeOperationId } = inspectBackups(store);
    if (corrupted.length > 0) {
        const first = corrupted[0];
        const opInfo = activeOperationId || first.id || 'unknown';
        throw new Error(`CORRUPTED_JOURNAL: Migration journal in backup ${opInfo} is corrupted or truncated; manual resolution required`);
    }

    const currentPlan = planMigration(store);

    // If there is an in-progress migration journal, resume it if the version/operation matches
    if (inProgress) {
        const j = inProgress.journal;
        const matchesOriginalVersion = j.version === version;
        const matchesOperationId = operationId && j.operationId === operationId;
        const matchesRemainingVersion = currentPlan.version === version;

        if (matchesOriginalVersion || matchesOperationId || matchesRemainingVersion) {
            // Resume the existing in-progress journal
            for (const entry of j.entries) {
                if (entry.status === 'COMPLETED') {
                    // Verify already completed entry is still valid
                    if (!fs.existsSync(entry.file)) {
                        throw new Error(`MIGRATION_VERSION_CONFLICT: Record ${entry.kind}/${entry.id} missing during resumed migration`);
                    }
                    const text = fs.readFileSync(entry.file, 'utf8');
                    const obj = JSON.parse(text);
                    if (obj.storageVersion !== entry.to) {
                        throw new Error(`MIGRATION_VERSION_CONFLICT: Record ${entry.kind}/${entry.id} modified during interrupted migration`);
                    }
                    if (entry.afterHash && hash(text) !== entry.afterHash) {
                        throw new Error(`MIGRATION_VERSION_CONFLICT: Record ${entry.kind}/${entry.id} modified during interrupted migration`);
                    }
                    continue;
                }

                // Ensure initial backup exists
                const backupTarget = entry.backupPath || path.join(inProgress.backupDir, entry.kind, entry.id, path.basename(entry.file));
                entry.backupPath = backupTarget;
                if (!fs.existsSync(backupTarget)) {
                    fs.mkdirSync(path.dirname(backupTarget), { recursive: true });
                    fs.copyFileSync(entry.file, backupTarget);
                }
                entry.status = 'BACKED_UP';

                // Check content before modifying
                const content = fs.readFileSync(entry.file, 'utf8');
                const currentHash = hash(content);
                if (currentHash !== entry.beforeHash) {
                    let alreadyMigrated = false;
                    try {
                        const rec = JSON.parse(content);
                        if (rec && rec.storageVersion === entry.to && fs.existsSync(entry.backupPath)) {
                            const backupText = fs.readFileSync(entry.backupPath, 'utf8');
                            if (hash(backupText) === entry.beforeHash) {
                                const backupRec = JSON.parse(backupText);
                                if (recordsMatchExceptVersion(rec, backupRec, entry.to)) {
                                    alreadyMigrated = true;
                                }
                            }
                        }
                    } catch {}

                    if (!alreadyMigrated) {
                        throw new Error(`MIGRATION_VERSION_CONFLICT: Record ${entry.kind}/${entry.id} modified during migration`);
                    }
                    entry.status = 'COMPLETED';
                    entry.afterHash = currentHash;
                    atomicJson(inProgress.journalPath, j);
                    continue;
                }

                const record = JSON.parse(content);
                record.storageVersion = entry.to;
                record.updatedAt = now();
                atomicJson(entry.file, record);

                entry.status = 'COMPLETED';
                entry.afterHash = hash(fs.readFileSync(entry.file, 'utf8'));
                atomicJson(inProgress.journalPath, j);
            }

            j.finishedAt = now();
            j.status = 'COMPLETED';
            atomicJson(inProgress.journalPath, j);

            return {
                operationId: j.operationId,
                version: j.version,
                backupDir: inProgress.backupDir,
                migrated: j.entries.length,
                entries: j.entries
            };
        }
    }

    if (currentPlan.version !== version) {
        throw new Error('MIGRATION_VERSION_CONFLICT: Storage content changed since migration preview was generated');
    }

    if (currentPlan.entries.length === 0) {
        return {
            operationId: null,
            version,
            backupDir: null,
            migrated: 0,
            entries: []
        };
    }

    const opId = crypto.randomUUID();
    const backupDir = path.join(store.root, 'backups', opId);
    fs.mkdirSync(backupDir, { recursive: true });

    const journalPath = path.join(backupDir, 'journal.json');
    const journalEntries = currentPlan.entries.map(e => ({
        kind: e.kind,
        id: e.id,
        file: e.file,
        beforeHash: e.beforeHash,
        afterHash: null,
        from: e.from,
        to: e.to,
        backupPath: path.join(backupDir, e.kind, e.id, path.basename(e.file)),
        status: 'PENDING'
    }));

    const journal = {
        operationId: opId,
        version,
        startedAt: now(),
        status: 'IN_PROGRESS',
        entries: journalEntries
    };
    atomicJson(journalPath, journal);

    // 1. Back up all entries first
    for (const entry of journalEntries) {
        fs.mkdirSync(path.dirname(entry.backupPath), { recursive: true });
        fs.copyFileSync(entry.file, entry.backupPath);
        entry.status = 'BACKED_UP';
    }
    atomicJson(journalPath, journal);

    // 2. Perform atomic upgrade on each entry and update journal progress
    for (const entry of journalEntries) {
        const content = fs.readFileSync(entry.file, 'utf8');
        const currentHash = hash(content);
        if (currentHash !== entry.beforeHash) {
            let alreadyMigrated = false;
            try {
                const rec = JSON.parse(content);
                if (rec && rec.storageVersion === entry.to && fs.existsSync(entry.backupPath)) {
                    const backupText = fs.readFileSync(entry.backupPath, 'utf8');
                    if (hash(backupText) === entry.beforeHash) {
                        const backupRec = JSON.parse(backupText);
                        if (recordsMatchExceptVersion(rec, backupRec, entry.to)) {
                            alreadyMigrated = true;
                        }
                    }
                }
            } catch {}
            if (!alreadyMigrated) {
                throw new Error(`MIGRATION_VERSION_CONFLICT: Record ${entry.kind}/${entry.id} modified during migration`);
            }
            entry.status = 'COMPLETED';
            entry.afterHash = currentHash;
            atomicJson(journalPath, journal);
            continue;
        }
        const record = JSON.parse(content);
        record.storageVersion = entry.to;
        record.updatedAt = now();
        atomicJson(entry.file, record);

        entry.status = 'COMPLETED';
        entry.afterHash = hash(fs.readFileSync(entry.file, 'utf8'));
        atomicJson(journalPath, journal);
    }

    journal.finishedAt = now();
    journal.status = 'COMPLETED';
    atomicJson(journalPath, journal);

    return {
        operationId: opId,
        version,
        backupDir,
        migrated: journalEntries.length,
        entries: journalEntries
    };
}

module.exports = {
    planMigration,
    applyMigration
};
