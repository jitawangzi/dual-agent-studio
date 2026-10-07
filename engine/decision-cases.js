/**
 * @file decision-cases.js
 * @author shuyongqiang
 * @description Decision cases and structured evidence referencing for dispute resolution.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { hash, now, workspaceKey } = require('./run-store');
const { evidenceKey, verificationKey } = require('./audit-triage');
const { CURRENT_STORAGE_VERSION } = require('./storage-schema');

const VALID_REF_KINDS = ['AUDIT_FINDING', 'AUDIT_COVERAGE', 'RUN_BUG', 'PLAN_QUESTION'];
const VALID_STATUSES = ['OPEN', 'ANALYZING', 'AWAITING_HUMAN', 'DECIDED', 'NEEDS_REVIEW'];

/**
 * Resolves an evidence reference against the current store state and creates an immutable snapshot.
 */
function resolveReference(store, ref, wsKey) {
    if (!ref || typeof ref !== 'object') throw new Error('INVALID_REFERENCE_FORMAT');
    if (!VALID_REF_KINDS.includes(ref.kind)) throw new Error(`INVALID_REFERENCE_KIND: ${ref.kind}`);
    if (typeof ref.recordId !== 'string' || !/^[a-f0-9-]{36}$/.test(ref.recordId)) throw new Error('INVALID_REFERENCE_RECORD_ID');
    if (typeof ref.itemId !== 'string' || !ref.itemId.trim()) throw new Error('INVALID_REFERENCE_ITEM_ID');

    const recordId = ref.recordId;
    const itemId = ref.itemId.trim();

    let snapshot = null;
    let link = '';

    if (ref.kind === 'AUDIT_FINDING') {
        let audit;
        try {
            audit = store.read('audits', recordId);
        } catch {
            throw new Error(`UNKNOWN_REFERENCE_RECORD: audit ${recordId} not found`);
        }
        if (audit.workspaceKey !== wsKey) throw new Error('CROSS_WORKSPACE_REFERENCE');
        const finding = audit.findings?.find(f => f.id === itemId);
        if (!finding) throw new Error(`UNKNOWN_REFERENCE_ITEM: finding ${itemId} not found in audit ${recordId}`);
        snapshot = {
            id: finding.id,
            category: finding.category,
            severity: finding.severity,
            file: finding.file,
            lineRange: finding.lineRange,
            problem: finding.problem,
            evidence: finding.evidence,
            evidenceKey: evidenceKey(finding),
            triageVersion: audit.triage?.[finding.id]?.version || 0,
            triageStatus: audit.triage?.[finding.id]?.status || 'UNREVIEWED'
        };
        link = `/api/audits/${recordId}#finding-${itemId}`;
    } else if (ref.kind === 'AUDIT_COVERAGE') {
        let audit;
        try {
            audit = store.read('audits', recordId);
        } catch {
            throw new Error(`UNKNOWN_REFERENCE_RECORD: audit ${recordId} not found`);
        }
        if (audit.workspaceKey !== wsKey) throw new Error('CROSS_WORKSPACE_REFERENCE');
        const reviewer = audit.reviewers?.find(r => r.id === itemId);
        if (reviewer) {
            snapshot = {
                reviewerId: reviewer.id,
                name: reviewer.name,
                scope: reviewer.scope || audit.scope,
                checklist: reviewer.checklist || [],
                status: reviewer.status,
                reportSummary: reviewer.report?.summary || null
            };
        } else if (itemId.includes(':')) {
            const [rId, taskId] = itemId.split(':');
            const r = audit.reviewers?.find(x => x.id === rId);
            if (!r) throw new Error(`UNKNOWN_REFERENCE_ITEM: reviewer ${rId} not found in audit ${recordId}`);
            const check = taskId.startsWith('C-') ? r.report?.taskChecks?.find(c => c.id === taskId) : null;
            if (!check && !r.checklist?.includes(taskId)) {
                throw new Error(`UNKNOWN_REFERENCE_ITEM: task check ${taskId} not found for reviewer ${rId}`);
            }
            snapshot = { reviewerId: r.id, taskId, check: check || null };
        } else {
            throw new Error(`UNKNOWN_REFERENCE_ITEM: coverage item ${itemId} not found in audit ${recordId}`);
        }
        link = `/api/audits/${recordId}#coverage-${itemId}`;
    } else if (ref.kind === 'RUN_BUG') {
        let run;
        try {
            run = store.read('runs', recordId);
        } catch {
            throw new Error(`UNKNOWN_REFERENCE_RECORD: run ${recordId} not found`);
        }
        if (run.workspaceKey !== wsKey) throw new Error('CROSS_WORKSPACE_REFERENCE');
        const bug = run.bugs?.find(b => b.id === itemId || b.sourceFindingId === itemId);
        if (!bug) throw new Error(`UNKNOWN_REFERENCE_ITEM: bug ${itemId} not found in run ${recordId}`);
        snapshot = {
            id: bug.id,
            problem: bug.problem,
            status: bug.status,
            category: bug.category || 'BUG',
            history: bug.history || []
        };
        link = `/api/runs/${recordId}#bug-${itemId}`;
    } else if (ref.kind === 'PLAN_QUESTION') {
        let record = null;
        try { record = store.read('plans', recordId); } catch {}
        if (!record) {
            try { record = store.read('discussions', recordId); } catch {}
        }
        if (!record) throw new Error(`UNKNOWN_REFERENCE_RECORD: record ${recordId} not found`);
        if (record.workspaceKey !== wsKey) throw new Error('CROSS_WORKSPACE_REFERENCE');
        const q = record.questions?.find(x => x.id === itemId) ||
                  record.requirements?.find(x => x.id === itemId || x.name === itemId);
        if (!q) throw new Error(`UNKNOWN_REFERENCE_ITEM: question/item ${itemId} not found in record ${recordId}`);
        snapshot = {
            id: itemId,
            text: typeof q === 'string' ? q : (q.text || q.question || q.description || JSON.stringify(q))
        };
        link = `/api/plans/${recordId}#question-${itemId}`;
    }

    const snapshotHash = hash(JSON.stringify(snapshot));
    return {
        kind: ref.kind,
        recordId,
        itemId,
        snapshot,
        snapshotHash,
        link
    };
}

/**
 * Validates and snapshots an anchor target (must be a finding in an audit).
 */
function resolveAnchor(store, anchor, wsKey) {
    if (!anchor) return null;
    if (typeof anchor !== 'object') throw new Error('INVALID_ANCHOR_FORMAT');
    if (typeof anchor.auditId !== 'string' || !/^[a-f0-9-]{36}$/.test(anchor.auditId)) {
        throw new Error('INVALID_ANCHOR_AUDIT_ID');
    }
    if (typeof anchor.findingId !== 'string' || !anchor.findingId.trim()) {
        throw new Error('INVALID_ANCHOR_FINDING_ID');
    }

    let audit;
    try {
        audit = store.read('audits', anchor.auditId);
    } catch {
        throw new Error(`UNKNOWN_ANCHOR_RECORD: audit ${anchor.auditId} not found`);
    }
    if (audit.workspaceKey !== wsKey) throw new Error('CROSS_WORKSPACE_REFERENCE');
    const finding = audit.findings?.find(f => f.id === anchor.findingId);
    if (!finding) throw new Error(`UNKNOWN_ANCHOR_FINDING: finding ${anchor.findingId} not found in audit ${anchor.auditId}`);

    const expectedEvKey = evidenceKey(finding);
    if (anchor.evidenceKey !== expectedEvKey) throw new Error('ANCHOR_EVIDENCE_MISMATCH');

    const currentTriageVer = audit.triage?.[finding.id]?.version || 0;
    if (anchor.triageVersion !== currentTriageVer) throw new Error('ANCHOR_VERSION_CONFLICT');

    const currentVerKey = verificationKey(audit, finding);
    if ((anchor.verificationKey || '') !== currentVerKey) throw new Error('ANCHOR_VERSION_CONFLICT');

    const anchorSnapshot = {
        auditId: anchor.auditId,
        findingId: anchor.findingId,
        evidenceKey: anchor.evidenceKey,
        triageVersion: anchor.triageVersion,
        verificationKey: anchor.verificationKey || '',
        findingSnapshot: {
            category: finding.category,
            severity: finding.severity,
            problem: finding.problem,
            file: finding.file,
            lineRange: finding.lineRange
        }
    };

    return {
        auditId: anchor.auditId,
        findingId: anchor.findingId,
        evidenceKey: anchor.evidenceKey,
        triageVersion: anchor.triageVersion,
        verificationKey: anchor.verificationKey || '',
        snapshot: anchorSnapshot,
        snapshotHash: hash(JSON.stringify(anchorSnapshot))
    };
}

/**
 * Creates a new decision case.
 */
function createCase(store, { workspaceRoot, title, question, anchor = null, references = [] }) {
    if (!store || typeof store.save !== 'function') throw new Error('STORE_REQUIRED');
    if (!workspaceRoot || typeof workspaceRoot !== 'string') throw new Error('WORKSPACE_REQUIRED');
    let realWs;
    try {
        realWs = fs.realpathSync(workspaceRoot);
    } catch {
        throw new Error('WORKSPACE_NOT_FOUND');
    }
    const wsKey = workspaceKey(realWs);

    if (typeof title !== 'string' || !title.trim()) throw new Error('EMPTY_TITLE');
    if (typeof question !== 'string' || !question.trim()) throw new Error('EMPTY_QUESTION');
    if (!Array.isArray(references)) throw new Error('REFERENCES_ARRAY_REQUIRED');

    // Deduplicate and validate references
    const seenRefs = new Set();
    const resolvedReferences = [];
    for (const ref of references) {
        if (!ref || typeof ref !== 'object') throw new Error('INVALID_REFERENCE_FORMAT');
        const key = `${ref.kind}:${ref.recordId}:${ref.itemId}`;
        if (seenRefs.has(key)) throw new Error(`DUPLICATE_REFERENCE: ${key}`);
        seenRefs.add(key);

        const resolved = resolveReference(store, ref, wsKey);
        resolvedReferences.push(resolved);
    }

    const resolvedAnchor = resolveAnchor(store, anchor, wsKey);

    const id = crypto.randomUUID();
    const evidenceHash = hash(JSON.stringify({
        anchorHash: resolvedAnchor?.snapshotHash || null,
        refHashes: resolvedReferences.map(r => r.snapshotHash)
    }));

    const caseRecord = {
        id,
        storageVersion: CURRENT_STORAGE_VERSION,
        workspaceRoot: realWs,
        workspaceKey: wsKey,
        title: title.trim(),
        question: question.trim(),
        status: 'OPEN',
        anchor: resolvedAnchor,
        references: resolvedReferences,
        evidenceHash,
        analysis: null,
        decisions: [],
        applications: [],
        createdAt: now(),
        updatedAt: now()
    };

    store.save('decision-cases', caseRecord);
    return caseRecord;
}

/**
 * Presents a decision case by resolving server evidence, determining staleness, and computing version hash.
 */
function presentCase(store, id) {
    if (!store || typeof store.read !== 'function') throw new Error('STORE_REQUIRED');
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('INVALID_RECORD_ID');

    const caseRecord = store.read('decision-cases', id);
    const wsKey = caseRecord.workspaceKey;

    let anchorStale = false;
    let presentedAnchor = null;

    if (caseRecord.anchor) {
        try {
            const audit = store.read('audits', caseRecord.anchor.auditId);
            const finding = audit.findings?.find(f => f.id === caseRecord.anchor.findingId);
            if (!finding) {
                anchorStale = true;
                presentedAnchor = { ...caseRecord.anchor, stale: true, missing: true };
            } else {
                const curEvKey = evidenceKey(finding);
                const curTriageVer = audit.triage?.[finding.id]?.version || 0;
                const curVerKey = verificationKey(audit, finding);
                if (curEvKey !== caseRecord.anchor.evidenceKey ||
                    curTriageVer !== caseRecord.anchor.triageVersion ||
                    curVerKey !== (caseRecord.anchor.verificationKey || '')) {
                    anchorStale = true;
                }
                presentedAnchor = {
                    ...caseRecord.anchor,
                    stale: anchorStale,
                    currentEvidenceKey: curEvKey,
                    currentTriageVersion: curTriageVer,
                    currentVerificationKey: curVerKey,
                    finding: {
                        id: finding.id,
                        category: finding.category,
                        severity: finding.severity,
                        file: finding.file,
                        lineRange: finding.lineRange,
                        problem: finding.problem,
                        evidence: finding.evidence,
                        triage: audit.triage?.[finding.id] || null
                    }
                };
            }
        } catch {
            anchorStale = true;
            presentedAnchor = { ...caseRecord.anchor, stale: true, missing: true };
        }
    }

    let referencesStale = false;
    const presentedReferences = (caseRecord.references || []).map(ref => {
        let currentSnapshot = null;
        let stale = false;
        try {
            const resolved = resolveReference(store, ref, wsKey);
            currentSnapshot = resolved.snapshot;
            stale = resolved.snapshotHash !== ref.snapshotHash;
        } catch {
            stale = true;
        }
        if (stale) referencesStale = true;
        return {
            kind: ref.kind,
            recordId: ref.recordId,
            itemId: ref.itemId,
            link: ref.link,
            snapshot: ref.snapshot,
            snapshotHash: ref.snapshotHash,
            stale,
            currentSnapshot: currentSnapshot || null
        };
    });

    const stale = anchorStale || referencesStale;
    let effectiveStatus = caseRecord.status;
    if (stale) {
        effectiveStatus = 'NEEDS_REVIEW';
    } else if (caseRecord.decisions && caseRecord.decisions.length > 0) {
        effectiveStatus = 'DECIDED';
    }

    const currentEvidenceState = hash(JSON.stringify({
        anchorStale,
        referencesStale,
        anchorHash: presentedAnchor ? (presentedAnchor.stale ? 'stale' : caseRecord.anchor.snapshotHash) : null,
        refHashes: presentedReferences.map(r => r.stale ? 'stale' : r.snapshotHash)
    }));

    const version = hash(JSON.stringify([
        caseRecord.id,
        caseRecord.updatedAt,
        (caseRecord.decisions || []).length,
        (caseRecord.applications || []).length,
        currentEvidenceState,
        caseRecord.analysis?.analyzedAt || null
    ]));

    const hasUnappliedDecision = (caseRecord.decisions || []).some(d => !d.applied && !['VERIFY_MORE', 'REPLAN'].includes(d.action));

    return {
        ...caseRecord,
        status: effectiveStatus,
        stale,
        version,
        anchor: presentedAnchor,
        references: presentedReferences,
        hasUnappliedDecision
    };
}

/**
 * Saves a human decision on a decision case.
 */
function decideCase(store, id, input = {}) {
    if (!store || typeof store.read !== 'function') throw new Error('STORE_REQUIRED');
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('INVALID_RECORD_ID');

    const caseRecord = store.read('decision-cases', id);
    if (!input.workspaceRoot || workspaceKey(input.workspaceRoot) !== caseRecord.workspaceKey) {
        throw new Error('CASE_WORKSPACE_MISMATCH');
    }

    const presented = presentCase(store, id);
    if (presented.stale) {
        throw new Error('CASE_EVIDENCE_STALE: Case evidence or anchor is stale; cannot make decision');
    }
    if (input.version && input.version !== presented.version) {
        throw new Error('CASE_VERSION_CONFLICT: Version conflict with current case state');
    }

    if (!input || typeof input !== 'object') throw new Error('INVALID_DECISION_INPUT');
    if (typeof input.note !== 'string' || !input.note.trim()) throw new Error('EMPTY_DECISION_NOTE');
    if (input.note.length > 10000) throw new Error('DECISION_NOTE_TOO_LONG');

    const action = input.action;
    const ALLOWED_DECISION_ACTIONS = ['CONFIRM', 'ACCEPT_SUGGESTION', 'DEFER', 'DISMISS', 'VERIFY_MORE', 'REPLAN'];
    if (!ALLOWED_DECISION_ACTIONS.includes(action)) {
        throw new Error(`INVALID_DECISION_ACTION: action '${action}' is not permitted`);
    }

    if (caseRecord.anchor) {
        const anchorCat = caseRecord.anchor.snapshot?.findingSnapshot?.category;
        if (action === 'CONFIRM' && !['BUG', 'RISK'].includes(anchorCat)) {
            throw new Error('INVALID_DECISION_ACTION: CONFIRM is only valid for BUG or RISK findings');
        }
        if (action === 'ACCEPT_SUGGESTION' && anchorCat !== 'SUGGESTION') {
            throw new Error('INVALID_DECISION_ACTION: ACCEPT_SUGGESTION is only valid for SUGGESTION findings');
        }
    } else {
        if (['CONFIRM', 'ACCEPT_SUGGESTION'].includes(action)) {
            throw new Error('INVALID_DECISION_ACTION: Cannot CONFIRM or ACCEPT_SUGGESTION on a case without an anchor finding');
        }
    }

    // Check complete business answers if questions were posed by analysis
    const answers = Array.isArray(input.answers) ? input.answers : [];
    if (caseRecord.analysis?.questions?.length > 0) {
        for (const q of caseRecord.analysis.questions) {
            const ans = answers.find(a => (a.questionId === q.id || a.id === q.id));
            const val = (ans?.answer || ans?.text || '').trim();
            if (!val) {
                throw new Error(`INCOMPLETE_BUSINESS_ANSWERS: Missing answer for question '${q.id}'`);
            }
        }
    }

    const decisionId = crypto.randomUUID();
    const decisionEntry = {
        id: decisionId,
        action,
        note: input.note.trim(),
        answers: answers.map(a => ({ id: a.id || a.questionId, text: (a.text || a.answer || '').trim() })),
        version: presented.version,
        decidedAt: now(),
        applied: false,
        appliedAt: null,
        applicationId: null
    };

    caseRecord.decisions = caseRecord.decisions || [];
    caseRecord.decisions.push(decisionEntry);
    caseRecord.status = 'DECIDED';
    store.save('decision-cases', caseRecord);

    return presentCase(store, id);
}

/**
 * Applies a decided action idempotently to the target anchor finding in an audit.
 */
function applyDecision(store, { caseId, decisionId, version, workspaceRoot }, options = {}) {
    if (!store || typeof store.read !== 'function') throw new Error('STORE_REQUIRED');
    if (typeof caseId !== 'string' || !/^[a-f0-9-]{36}$/.test(caseId)) throw new Error('INVALID_RECORD_ID');

    const caseRecord = store.read('decision-cases', caseId);
    if (!workspaceRoot || workspaceKey(workspaceRoot) !== caseRecord.workspaceKey) {
        throw new Error('CASE_WORKSPACE_MISMATCH');
    }

    const decision = (caseRecord.decisions || []).find(d => d.id === decisionId);
    if (!decision) throw new Error('UNKNOWN_DECISION_ID');

    if (!caseRecord.anchor) {
        throw new Error('CASE_HAS_NO_ANCHOR: Case has no anchor finding to apply triage to');
    }

    if (['VERIFY_MORE', 'REPLAN'].includes(decision.action)) {
        throw new Error(`CANNOT_APPLY_ACTION_TO_TRIAGE: Action '${decision.action}' does not map to finding triage; follow navigation target`);
    }

    const presented = presentCase(store, caseId);
    if (version && version !== presented.version) {
        throw new Error('CASE_VERSION_CONFLICT: Version conflict with current case state');
    }

    const actionToTriage = {
        CONFIRM: 'CONFIRMED',
        ACCEPT_SUGGESTION: 'ACCEPTED',
        DEFER: 'DEFERRED',
        DISMISS: 'DISMISSED'
    };
    const targetTriageStatus = actionToTriage[decision.action];
    if (!targetTriageStatus) {
        throw new Error(`UNSUPPORTED_TRIAGE_ACTION: ${decision.action}`);
    }

    caseRecord.applications = caseRecord.applications || [];
    let appLog = caseRecord.applications.find(a => a.decisionId === decisionId);
    let applicationId;
    if (appLog) {
        applicationId = appLog.applicationId;
    } else {
        applicationId = crypto.randomUUID();
        appLog = {
            applicationId,
            decisionId,
            status: 'PENDING',
            startedAt: now()
        };
        caseRecord.applications.push(appLog);
        store.save('decision-cases', caseRecord);
    }

    const audit = store.read('audits', caseRecord.anchor.auditId);
    const finding = audit.findings?.find(f => f.id === caseRecord.anchor.findingId);
    if (!finding) throw new Error('UNKNOWN_ANCHOR_FINDING');

    const triageHistory = audit.triage?.[finding.id]?.history || [];
    const alreadyApplied = triageHistory.find(h => h.decisionApplicationId === applicationId);

    if (alreadyApplied) {
        appLog.status = 'APPLIED';
        appLog.finishedAt = alreadyApplied.at;
        decision.applied = true;
        decision.appliedAt = alreadyApplied.at;
        decision.applicationId = applicationId;
        store.save('decision-cases', caseRecord);
        return { ok: true, alreadyApplied: true, applicationId };
    }

    // Check anchor conflicts
    const curEvKey = evidenceKey(finding);
    if (curEvKey !== caseRecord.anchor.evidenceKey) {
        appLog.status = 'CONFLICT';
        appLog.error = 'ANCHOR_EVIDENCE_CHANGED';
        store.save('decision-cases', caseRecord);
        throw new Error('ANCHOR_CONFLICT: Anchor finding evidence changed');
    }
    const curTriageVer = audit.triage?.[finding.id]?.version || 0;
    if (curTriageVer !== caseRecord.anchor.triageVersion) {
        appLog.status = 'CONFLICT';
        appLog.error = 'ANCHOR_TRIAGE_MODIFIED';
        store.save('decision-cases', caseRecord);
        throw new Error('ANCHOR_CONFLICT: Anchor finding triage was modified by another operation');
    }
    const curVerKey = verificationKey(audit, finding);
    if (curVerKey !== (caseRecord.anchor.verificationKey || '')) {
        appLog.status = 'CONFLICT';
        appLog.error = 'ANCHOR_VERIFICATION_MODIFIED';
        store.save('decision-cases', caseRecord);
        throw new Error('ANCHOR_CONFLICT: Anchor finding verification was modified');
    }

    // Apply triage using applyTriage
    const { applyTriage } = require('./audit-triage');
    applyTriage(audit, {
        findingId: finding.id,
        status: targetTriageStatus,
        note: `[决策: ${caseRecord.title}] ${decision.note}`,
        evidenceKey: caseRecord.anchor.evidenceKey,
        verificationKey: caseRecord.anchor.verificationKey || '',
        version: caseRecord.anchor.triageVersion,
        decisionApplicationId: applicationId
    });

    if (options.injectWriteFailure) {
        throw new Error('INJECTED_WRITE_FAILURE');
    }

    store.save('audits', audit);

    appLog.status = 'APPLIED';
    appLog.finishedAt = now();
    decision.applied = true;
    decision.appliedAt = appLog.finishedAt;
    decision.applicationId = applicationId;

    // Update anchor triageVersion in caseRecord
    caseRecord.anchor.triageVersion = audit.triage[finding.id].version;
    store.save('decision-cases', caseRecord);

    return presentCase(store, caseId);
}

module.exports = {
    VALID_REF_KINDS,
    VALID_STATUSES,
    createCase,
    presentCase,
    resolveReference,
    resolveAnchor,
    decideCase,
    applyDecision
};
