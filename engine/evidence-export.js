/**
 * @file evidence-export.js
 * @author shuyongqiang
 * @description Evidence bundle planning, redaction, artifact resolution, and manifest generation (v2.14 Task 1).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { now, hash } = require('./run-store');

const CURRENT_EXPORT_FORMAT_VERSION = 1;
const MAX_RECORDS_BYTES = 5 * 1024 * 1024;    // 5 MiB
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;    // 20 MiB

const EXPORT_LIMITATIONS = [
    'Historical evidence; not current execution authorization.',
    'Manifest hashes verify package internal byte integrity only, not content truthfulness or author identity.',
    'Path redaction and masking do not guarantee detection of all sensitive tokens, credentials, or secrets.'
];

/**
 * Deterministically serialize an object to JSON with sorted keys.
 */
function canonicalJson(obj) {
    function sortKeys(value) {
        if (value === null || typeof value !== 'object') return value;
        if (Array.isArray(value)) return value.map(sortKeys);
        const sorted = {};
        for (const k of Object.keys(value).sort()) {
            sorted[k] = sortKeys(value[k]);
        }
        return sorted;
    }
    return JSON.stringify(sortKeys(obj), null, 2);
}

/**
 * Safely resolves an artifact file within a record's directory.
 * Defends against traversal (../), symlink escape, and reserved files.
 */
function resolveExportArtifact(recordDir, name) {
    if (typeof recordDir !== 'string' || !recordDir.trim()) {
        throw new Error('INVALID_RECORD_DIRECTORY');
    }
    if (typeof name !== 'string' || !name.trim()) {
        throw new Error('INVALID_ARTIFACT_NAME: Artifact name is required');
    }
    if (path.basename(name) !== name || name.includes('/') || name.includes('\\') || name.includes('..')) {
        throw new Error('INVALID_ARTIFACT_NAME: Path separators or traversal sequences are not permitted');
    }
    if (!/^[a-zA-Z0-9_\-\.]+$/.test(name)) {
        throw new Error(`INVALID_ARTIFACT_NAME: Forbidden characters in artifact name '${name}'`);
    }
    if (name.toLowerCase() === 'state.json') {
        throw new Error('INVALID_ARTIFACT_NAME: state.json is reserved for record state and cannot be exported as an attachment');
    }

    if (!fs.existsSync(recordDir)) {
        throw new Error('RECORD_DIRECTORY_NOT_FOUND');
    }

    const fullPath = path.join(recordDir, name);
    if (!fs.existsSync(fullPath)) {
        throw new Error(`ARTIFACT_NOT_FOUND: Artifact '${name}' does not exist in record directory`);
    }

    const resolvedRecordDir = fs.realpathSync(recordDir);
    const resolvedFile = fs.realpathSync(fullPath);

    // Verify resolved file is strictly located inside resolved record directory
    const prefix = resolvedRecordDir.endsWith(path.sep) ? resolvedRecordDir : resolvedRecordDir + path.sep;
    if (!resolvedFile.startsWith(prefix)) {
        throw new Error('INVALID_ARTIFACT: Path escapes record directory boundary');
    }

    const stat = fs.statSync(resolvedFile);
    if (!stat.isFile()) {
        throw new Error('INVALID_ARTIFACT: Artifact must be a regular file');
    }

    return resolvedFile;
}

/**
 * Traverses related records starting from a root audit to compute the closed set of evidence records.
 */
function collectExportClosure(store, auditId) {
    if (!store || typeof store.read !== 'function') throw new Error('STORE_REQUIRED');
    if (typeof auditId !== 'string' || !/^[a-f0-9-]{36}$/.test(auditId)) throw new Error('INVALID_RECORD_ID');

    const visited = new Set();
    const records = [];
    const omissions = [];
    const warnings = [];

    // Helper to safely fetch a record
    function tryFetch(kind, id) {
        const key = `${kind}:${id}`;
        if (visited.has(key)) return null;
        visited.add(key);

        try {
            const record = store.read(kind, id);
            records.push({ kind, id, record });
            return record;
        } catch (err) {
            omissions.push({ kind, id, reason: err.message.includes('ENOENT') ? 'RECORD_NOT_FOUND' : 'CORRUPTED_RECORD' });
            return null;
        }
    }

    // 1. Root audit
    const rootAudit = tryFetch('audits', auditId);
    if (!rootAudit) {
        throw new Error(`ROOT_AUDIT_NOT_FOUND: Audit '${auditId}' could not be loaded`);
    }

    const wsKey = rootAudit.workspaceKey;

    // 2. Discover full audit family transitively (BFS fixed point)
    const auditIds = new Set([auditId]);
    let allAudits = [];
    try {
        allAudits = store.list('audits').filter(a => !a.workspaceKey || a.workspaceKey === wsKey);
    } catch {}

    let auditChanged = true;
    while (auditChanged) {
        auditChanged = false;
        for (const a of allAudits) {
            if (auditIds.has(a.id)) {
                const parentId = a.parentAuditId || a.parentAudit?.id || a.targetedPlan?.baseAuditId;
                if (parentId && !auditIds.has(parentId)) {
                    auditIds.add(parentId);
                    auditChanged = true;
                }
            } else {
                const parentId = a.parentAuditId || a.parentAudit?.id || a.targetedPlan?.baseAuditId;
                if (parentId && auditIds.has(parentId)) {
                    auditIds.add(a.id);
                    auditChanged = true;
                }
            }
        }
    }

    // Fetch all collected audits
    for (const aId of auditIds) {
        tryFetch('audits', aId);
    }

    // 3. Scan runs for repair runs and runs referencing any collected audit
    let allRuns = [];
    try {
        allRuns = store.list('runs').filter(r => !r.workspaceKey || r.workspaceKey === wsKey);
    } catch {}

    for (const r of allRuns) {
        const matchesAudit = auditIds.has(r.sourceAuditId) ||
                             auditIds.has(r.sourceAudit) ||
                             auditIds.has(r.sourceAudit?.id) ||
                             auditIds.has(r.closureAuditId) ||
                             (r.closureAudit?.id && auditIds.has(r.closureAudit.id));
        if (matchesAudit) {
            tryFetch('runs', r.id);
        }
    }

    // 4. Scan plans and discussions referenced by audits or runs
    for (const item of [...records]) {
        if (item.record) {
            if (item.record.planId) tryFetch('plans', item.record.planId);
            if (item.record.approval?.planId) tryFetch('plans', item.record.approval.planId);
        }
    }
    for (const item of [...records]) {
        if (item.kind === 'plans' && item.record) {
            if (item.record.planningId) tryFetch('discussions', item.record.planningId);
            if (item.record.discussionId) tryFetch('discussions', item.record.discussionId);
        }
    }

    // 5. Scan decision cases referencing any audit or plan in closure
    try {
        const allCases = store.list('decision-cases').filter(c => !c.workspaceKey || c.workspaceKey === wsKey);
        for (const c of allCases) {
            const matchesAnchor = c.anchor?.auditId && auditIds.has(c.anchor.auditId);
            const matchesRef = Array.isArray(c.references) && c.references.some(ref => {
                if (auditIds.has(ref.recordId)) return true;
                if (visited.has(`plans:${ref.recordId}`)) return true;
                return false;
            });
            if (matchesAnchor || matchesRef) {
                tryFetch('decision-cases', c.id);
            }
        }
    } catch {}

    // Sort records deterministically by kind and id
    records.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));

    return { records, omissions, warnings, rootAudit };
}

/**
 * Plans evidence export without modifying disk.
 */
function planExport(store, options = {}) {
    const { auditId, includeArtifacts = false, redactPaths = true } = options;
    const { records, omissions, warnings, rootAudit } = collectExportClosure(store, auditId);

    const recordRefs = records.map(r => ({ kind: r.kind, id: r.id }));
    const artifactRefs = [];

    let totalArtifactBytes = 0;

    if (includeArtifacts) {
        for (const rec of records) {
            const recDir = path.join(store.root, rec.kind, rec.id);
            if (!fs.existsSync(recDir)) continue;

            const entries = fs.readdirSync(recDir);
            for (const entry of entries) {
                if (entry.toLowerCase() === 'state.json') continue;
                try {
                    const resolvedPath = resolveExportArtifact(recDir, entry);
                    const stat = fs.statSync(resolvedPath);
                    const artifactName = `artifacts/${rec.kind}/${rec.id}/${entry}`;
                    artifactRefs.push({
                        name: artifactName,
                        kind: rec.kind,
                        recordId: rec.id,
                        fileName: entry,
                        path: resolvedPath,
                        bytes: stat.size
                    });
                    totalArtifactBytes += stat.size;
                } catch (err) {
                    warnings.push({
                        kind: rec.kind,
                        recordId: rec.id,
                        fileName: entry,
                        reason: err.message
                    });
                }
            }
        }
    }

    // Estimate records JSON size
    const estimatedRecordsBytes = Buffer.byteLength(JSON.stringify(records), 'utf8');
    const estimatedTotalBytes = estimatedRecordsBytes + totalArtifactBytes;

    if (estimatedRecordsBytes > MAX_RECORDS_BYTES) {
        warnings.push({
            code: 'RECORDS_SIZE_LIMIT_EXCEEDED',
            message: `Estimated records size (${(estimatedRecordsBytes / 1024 / 1024).toFixed(2)} MiB) exceeds ${MAX_RECORDS_BYTES / 1024 / 1024} MiB limit.`
        });
    }

    if (estimatedTotalBytes > MAX_BUNDLE_BYTES) {
        warnings.push({
            code: 'BUNDLE_SIZE_LIMIT_EXCEEDED',
            message: `Estimated total bundle size (${(estimatedTotalBytes / 1024 / 1024).toFixed(2)} MiB) exceeds ${MAX_BUNDLE_BYTES / 1024 / 1024} MiB limit.`
        });
    }

    // Deterministic version hash of all records' timestamps & states + export options
    const versionHasher = crypto.createHash('sha256');
    versionHasher.update(`v1|audit:${auditId}|includeArtifacts:${Boolean(includeArtifacts)}|redact:${Boolean(redactPaths)}|`);
    for (const r of records) {
        versionHasher.update(`${r.kind}:${r.id}:${r.record.storageVersion || 0}:${r.record.updatedAt || ''};`);
    }
    for (const a of artifactRefs) {
        versionHasher.update(`${a.name}:${a.bytes};`);
    }
    const version = versionHasher.digest('hex');

    return {
        version,
        auditId,
        recordRefs,
        artifactRefs,
        omissions,
        warnings,
        estimatedBytes: estimatedTotalBytes
    };
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Applies text and path redactions to string values in a data structure.
 */
function redactObject(value, pathReplacements, customRules = []) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
        let str = value;
        for (const { from, to } of pathReplacements) {
            if (from) {
                // Global case-insensitive and slash-agnostic replacement for paths
                const escapedParts = from.split(/[\\/]/).map(escapeRegex);
                const pattern = escapedParts.join('[\\\\/]');
                const regex = new RegExp(pattern, 'gi');
                str = str.replace(regex, to);
            }
        }
        for (const rule of customRules) {
            if (rule && rule.pattern && rule.replacement !== undefined) {
                str = str.replace(new RegExp(rule.pattern, 'g'), rule.replacement);
            }
        }
        return str;
    }
    if (Array.isArray(value)) {
        return value.map(item => redactObject(item, pathReplacements, customRules));
    }
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = redactObject(v, pathReplacements, customRules);
        }
        return out;
    }
    return value;
}

/**
 * Builds the complete export bundle with deterministic manifest.
 */
function buildExport(store, options = {}) {
    const { version, auditId, includeArtifacts = false, redactPaths = true, redactRules = [] } = options;
    const plan = planExport(store, { auditId, includeArtifacts, redactPaths });

    if (version && plan.version !== version) {
        throw new Error('EXPORT_VERSION_CONFLICT: Source records or attachments have changed since export plan was computed');
    }

    if (plan.estimatedBytes > MAX_BUNDLE_BYTES) {
        throw new Error(`EXPORT_SIZE_EXCEEDED: Total estimated bundle size exceeds ${MAX_BUNDLE_BYTES / 1024 / 1024} MiB limit. Exclude attachments or reduce scope.`);
    }

    const { records: rawRecords } = collectExportClosure(store, auditId);

    // Prepare path replacements
    const pathReplacements = [];
    if (redactPaths) {
        const home = os.homedir();
        if (home) pathReplacements.push({ from: home, to: '<USER_HOME>' });
        const tmp = os.tmpdir();
        if (tmp) pathReplacements.push({ from: tmp, to: '<TMP_DIR>' });

        // Collect workspace roots and workspace keys from records
        for (const r of rawRecords) {
            const ws = r.record?.workspaceRoot;
            if (ws && typeof ws === 'string') {
                pathReplacements.push({ from: ws, to: '<WORKSPACE_ROOT>' });
            }
            const wk = r.record?.workspaceKey;
            if (wk && typeof wk === 'string') {
                pathReplacements.push({ from: wk, to: '<WORKSPACE_ROOT>' });
            }
        }
    }

    // Sort pathReplacements by descending length so longest specific path matches first
    pathReplacements.sort((a, b) => b.from.length - a.from.length);

    // Format records map
    const exportedRecords = {};
    for (const r of rawRecords) {
        const cloned = JSON.parse(JSON.stringify(r.record));
        const redacted = redactPaths ? redactObject(cloned, pathReplacements, redactRules) : cloned;
        if (!exportedRecords[r.kind]) exportedRecords[r.kind] = [];
        exportedRecords[r.kind].push(redacted);
    }

    // Canonical JSON serialization for records
    const recordsJson = canonicalJson(exportedRecords);
    const recordsBytes = Buffer.byteLength(recordsJson, 'utf8');

    if (recordsBytes > MAX_RECORDS_BYTES) {
        throw new Error(`EXPORT_SIZE_EXCEEDED: Structured records size (${(recordsBytes / 1024 / 1024).toFixed(2)} MiB) exceeds ${MAX_RECORDS_BYTES / 1024 / 1024} MiB limit`);
    }

    const manifest = [
        {
            name: 'records.json',
            sha256: hash(recordsJson),
            bytes: recordsBytes
        }
    ];

    const artifacts = {};
    for (const art of plan.artifactRefs) {
        const rawContent = fs.readFileSync(art.path);
        const artSha256 = crypto.createHash('sha256').update(rawContent).digest('hex');
        manifest.push({
            name: art.name,
            sha256: artSha256,
            bytes: rawContent.length
        });

        artifacts[art.name] = {
            encoding: 'base64',
            content: rawContent.toString('base64'),
            bytes: rawContent.length
        };
    }

    // Sort manifest by name deterministically
    manifest.sort((a, b) => a.name.localeCompare(b.name));

    return {
        formatVersion: CURRENT_EXPORT_FORMAT_VERSION,
        generatedAt: now(),
        auditId,
        redacted: Boolean(redactPaths),
        records: exportedRecords,
        artifacts,
        manifest,
        omissions: plan.omissions,
        limitations: EXPORT_LIMITATIONS
    };
}

module.exports = {
    CURRENT_EXPORT_FORMAT_VERSION,
    MAX_RECORDS_BYTES,
    MAX_BUNDLE_BYTES,
    EXPORT_LIMITATIONS,
    canonicalJson,
    resolveExportArtifact,
    collectExportClosure,
    planExport,
    buildExport
};
