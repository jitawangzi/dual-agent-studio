'use strict';
/**
 * Targeted Review Plan Generator (2.12 Task 2).
 *
 * Deterministically constructs review plans for small change sets.
 * Conservative expansion rules: requiresFullAudit = true when
 * deletions, config/migration/public-API changes, or unassigned scopes occur.
 *
 * @author shuyongqiang
 */

const { compareManifests, GLOBAL_CONFIG_REGEX } = require('./source-manifest');
const { estimateExecution } = require('./execution-estimate');
const { hash } = require('./run-store');

const MIGRATION_REGEX = /(^|\/)(migrations?|db\/migrate|flyway|liquibase)\/|.*migration.*\.sql$/i;
const PUBLIC_API_REGEX = /(^|\/)(routes|api|proto|graphql|openapi|swagger)\b|(\b(public-api|contracts)\b)/i;

const DEFAULT_EXPANSION_RULES = [
    { id: 'NO_BASE_MANIFEST', description: '缺少基准清单，无法确定历史比对基准' },
    { id: 'DELETED_FILES', description: '检测到文件被删除，删除行为无法在局部隔离范围内安全验证' },
    { id: 'GLOBAL_CONFIG', description: '构建脚本、全局依赖或环境配置被修改' },
    { id: 'MIGRATIONS', description: '数据库迁移或持久化模式文件发生变更' },
    { id: 'PUBLIC_APIS', description: '公共路由、接口协议或外部契约文件发生变更' },
    { id: 'UNCOVERED_SCOPES', description: '存在未分配至任何审核员范围的变更文件' },
    { id: 'LARGE_CHANGE_SET', description: '变更文件总数超过定向审核阈值 (20)' },
    { id: 'ALL_FILES_CHANGED', description: '全量文件均发生变动' }
];

function normalizePosix(p) {
    return (p || '').replace(/\\/g, '/');
}

function parseScopePatterns(scopeString) {
    if (!scopeString || typeof scopeString !== 'string') return [];
    const parts = scopeString.split(/[\r\n,;]+/).map(s => s.trim()).filter(Boolean);
    const patterns = [];
    for (const part of parts) {
        // Exclude generic human language descriptions (e.g. Chinese characters or spaces)
        if (/[\s\u4e00-\u9fa5\u3000-\u303f]/.test(part)) {
            continue;
        }
        const normalized = normalizePosix(part).replace(/^\.?\//, '');
        if (normalized) {
            patterns.push(normalized);
        }
    }
    return patterns;
}

function fileMatchesPattern(filePath, pattern) {
    const normFile = normalizePosix(filePath).replace(/^\.?\//, '');
    const normPattern = normalizePosix(pattern).replace(/^\.?\//, '');

    if (normPattern === '.' || normPattern === '') return true;

    // Exact match
    if (normFile === normPattern) return true;

    // Directory prefix match
    if (normPattern.endsWith('/')) {
        return normFile.startsWith(normPattern);
    }
    if (normFile.startsWith(normPattern + '/')) {
        return true;
    }

    // Glob pattern with '*'
    if (normPattern.includes('*')) {
        const regexStr = '^' + normPattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*\*/g, '.*')
            .replace(/(?<!\.)\*/g, '[^/]*') + '$';
        try {
            const regex = new RegExp(regexStr);
            return regex.test(normFile);
        } catch (_) {
            return false;
        }
    }

    return false;
}

function buildTargetedPlan({ audit, manifestBefore, manifestAfter, findings, reviewers, options = {} } = {}) {
    if (!audit || typeof audit !== 'object') {
        throw new Error('INVALID_AUDIT: audit record is required');
    }
    if (!manifestAfter || typeof manifestAfter !== 'object' || !Array.isArray(manifestAfter.entries)) {
        throw new Error('INVALID_TARGET_MANIFEST: manifestAfter must be a valid manifest');
    }

    const baseAuditId = audit.id || null;
    const effectiveManifestBefore = manifestBefore || audit.manifest || null;
    const rawReviewers = (Array.isArray(reviewers) && reviewers.length > 0)
        ? reviewers
        : (Array.isArray(audit.reviewers) ? audit.reviewers : []);
    const rawFindings = Array.isArray(findings)
        ? findings
        : (Array.isArray(audit.findings) ? audit.findings : []);

    // 1. Compare manifests
    const changes = compareManifests(effectiveManifestBefore, manifestAfter);
    const changedFiles = [...new Set([...changes.added, ...changes.modified, ...changes.deleted])].sort();

    let requiresFullAudit = Boolean(changes.requiresFullAudit);
    const reasons = [...changes.reasons];

    // 2. Conservative scope widening checks
    // Migration files
    const migrationChanges = changedFiles.filter(f => MIGRATION_REGEX.test(f));
    if (migrationChanges.length > 0) {
        requiresFullAudit = true;
        reasons.push(`MIGRATION_FILE_CHANGED: 检测到数据库迁移或模式定义变更: ${migrationChanges.join(', ')}`);
    }

    // Public API / routes / schemas
    const publicApiChanges = changedFiles.filter(f => PUBLIC_API_REGEX.test(f));
    if (publicApiChanges.length > 0) {
        requiresFullAudit = true;
        reasons.push(`PUBLIC_API_CHANGED: 检测到公共路由或接口协议定义变更: ${publicApiChanges.join(', ')}`);
    }

    // 3. Match changed files to reviewers
    const reviewerFileMap = new Map();
    for (const r of rawReviewers) {
        reviewerFileMap.set(r.id, []);
    }

    const uncoveredScopes = [];
    for (const file of changedFiles) {
        let matched = false;
        for (const r of rawReviewers) {
            const patterns = parseScopePatterns(r.scope);
            if (patterns.some(p => fileMatchesPattern(file, p))) {
                reviewerFileMap.get(r.id).push(file);
                matched = true;
            }
        }
        if (!matched) {
            uncoveredScopes.push({
                path: file,
                scope: file,
                reason: 'NO_MATCHING_REVIEWER_SCOPE'
            });
        }
    }

    // If any changed file has no matching reviewer scope, full audit is required
    if (uncoveredScopes.length > 0) {
        requiresFullAudit = true;
        reasons.push(`UNCOVERED_SCOPES: 存在 ${uncoveredScopes.length} 个变更文件未匹配任何审核员范围 (${uncoveredScopes.map(u => u.path).join(', ')})`);
    }

    // 4. Candidate findings to re-check
    // Include unclosed findings and closed bugs whose evidence is expired
    const candidateFindings = [];
    const currentSnapshot = manifestAfter.snapshot || null;

    for (const f of rawFindings) {
        if (!f || typeof f !== 'object') continue;
        const triageStatus = f.triage?.status;
        const state = f.state;

        // Dismissed or deferred findings are excluded
        if (triageStatus === 'DISMISSED' || triageStatus === 'DEFERRED' || state === 'DISMISSED' || state === 'DEFERRED') {
            continue;
        }

        const isDeletedFile = changes.deleted.includes(normalizePosix(f.file));
        const isChangedFile = changedFiles.includes(normalizePosix(f.file));
        const isClosed = state === 'CLOSED' || triageStatus === 'CLOSED';
        const isStaleProof = f.stale === true || (f.snapshot && f.snapshot !== currentSnapshot) || (f.verification?.stale === true);

        if (!isClosed) {
            // Still open finding
            candidateFindings.push({
                finding: f,
                reason: isDeletedFile ? 'DELETED_FILE_ASSOCIATED_ISSUE' : 'UNCLOSED_ISSUE'
            });
        } else if (isChangedFile || isStaleProof || isDeletedFile) {
            // Closed finding with expired / modified evidence
            candidateFindings.push({
                finding: f,
                reason: isDeletedFile ? 'DELETED_FILE_ASSOCIATED_ISSUE' : (isChangedFile ? 'TOUCHED_FILE_EVIDENCE_EXPIRED' : 'SNAPSHOT_EXPIRED')
            });
        }
    }

    // 5. Match candidate findings to reviewers
    const reviewerFindingMap = new Map();
    for (const r of rawReviewers) {
        reviewerFindingMap.set(r.id, []);
    }

    for (const { finding, reason } of candidateFindings) {
        const normFile = normalizePosix(finding.file);
        let matched = false;

        for (const r of rawReviewers) {
            const patterns = parseScopePatterns(r.scope);
            const matchesPath = patterns.some(p => fileMatchesPattern(normFile, p));
            const wasOrigin = (finding.sources || []).some(s => s.reviewerId === r.id) || finding.reviewerId === r.id;

            if (matchesPath || wasOrigin) {
                reviewerFindingMap.get(r.id).push({ finding, reason });
                matched = true;
            }
        }

        if (!matched) {
            uncoveredScopes.push({
                path: normFile,
                scope: normFile,
                findingId: finding.id,
                reason: 'UNASSIGNED_FINDING_SCOPE'
            });
            requiresFullAudit = true;
            reasons.push(`UNASSIGNED_FINDING: 问题 [${finding.id}] (${normFile}) 未匹配任何审核员范围`);
        }
    }

    // 6. Build proposed tasks and batch if exceeding 20 items
    const proposedTasks = [];
    const MAX_CHECKLIST_PER_TASK = options.maxChecklistPerTask || 20;

    for (const r of rawReviewers) {
        const matchedFiles = [...new Set(reviewerFileMap.get(r.id) || [])].sort();
        const matchedFindings = reviewerFindingMap.get(r.id) || [];

        if (matchedFiles.length === 0 && matchedFindings.length === 0) {
            continue;
        }

        // Build list of checklist items
        const rawItems = [];
        for (const file of matchedFiles) {
            rawItems.push({
                type: 'FILE',
                file,
                text: `复查变更文件: ${file}`
            });
        }
        for (const { finding, reason } of matchedFindings) {
            const extra = reason === 'DELETED_FILE_ASSOCIATED_ISSUE'
                ? ' (文件已删除，复核该问题是否已安全消除)'
                : (finding.acceptance ? ` (验收标准: ${finding.acceptance})` : '');
            rawItems.push({
                type: 'FINDING',
                findingId: finding.id,
                text: `复核问题 [${finding.id}] ${finding.file}: ${finding.problem}${extra}`
            });
        }

        // Explicitly batch if > 20 items
        const totalBatches = Math.ceil(rawItems.length / MAX_CHECKLIST_PER_TASK);
        for (let b = 0; b < totalBatches; b++) {
            const chunk = rawItems.slice(b * MAX_CHECKLIST_PER_TASK, (b + 1) * MAX_CHECKLIST_PER_TASK);
            const batchNum = b + 1;
            const taskId = totalBatches === 1 ? `TP-${r.id}` : `TP-${r.id}-B${batchNum}`;
            const fileCount = chunk.filter(c => c.type === 'FILE').length;
            const findingCount = chunk.filter(c => c.type === 'FINDING').length;

            proposedTasks.push({
                id: taskId,
                reviewerId: r.id,
                reviewerName: r.name,
                provider: r.provider,
                model: r.model,
                reasoningEffort: r.reasoningEffort,
                batch: batchNum,
                totalBatches,
                scope: r.scope,
                checklist: chunk.map(c => c.text),
                sourceFindingIds: [...new Set(chunk.filter(c => c.findingId).map(c => c.findingId))],
                reason: totalBatches === 1
                    ? `定向复查 ${r.name} 范围 (${fileCount} 个变更文件, ${findingCount} 个问题)`
                    : `定向复查 ${r.name} 范围 (第 ${batchNum}/${totalBatches} 批次, 共 ${chunk.length} 项)`
            });
        }
    }

    // 7. Estimate execution attempts (Task 2 / 2.11 reuse)
    let estimatedAttempts;
    if (proposedTasks.length > 0) {
        estimatedAttempts = estimateExecution('audit', {
            reviewers: proposedTasks.map(t => ({
                id: t.id,
                name: t.reviewerName,
                provider: t.provider || 'mock',
                model: t.model || ''
            }))
        });
    } else {
        estimatedAttempts = {
            minimumAttempts: 0,
            maximumAttempts: 0,
            assumptions: ['无匹配的定向复查任务']
        };
    }

    // 8. Deterministic version binding
    const version = hash(JSON.stringify([
        baseAuditId,
        effectiveManifestBefore?.snapshot || null,
        manifestAfter.snapshot || null,
        changedFiles,
        proposedTasks.map(t => ({
            id: t.id,
            reviewerId: t.reviewerId,
            batch: t.batch,
            checklist: t.checklist,
            sourceFindingIds: t.sourceFindingIds
        })),
        uncoveredScopes,
        requiresFullAudit,
        reasons
    ]));

    return {
        version,
        sourceSnapshot: manifestAfter.snapshot || null,
        baseAuditId,
        changedFiles,
        proposedTasks,
        uncoveredScopes,
        requiresFullAudit,
        reasons: [...new Set(reasons)],
        estimatedAttempts
    };
}

module.exports = {
    buildTargetedPlan,
    parseScopePatterns,
    fileMatchesPattern,
    DEFAULT_EXPANSION_RULES,
    MIGRATION_REGEX,
    PUBLIC_API_REGEX
};
