/**
 * @file decision-analysis.js
 * @author shuyongqiang
 * @description Single-shot structured arbitration analysis for decision cases (v2.13 Task 2).
 */
'use strict';

const crypto = require('crypto');
const { now, workspaceKey } = require('./run-store');
const { normalizeReviewer } = require('./audit-config');
const { ensureBudget, startActiveTracking, stopActiveTracking } = require('./execution-budget');
const { trackedCall } = require('./call-ledger');
const { invokeAgent } = require('./process-runner');
const { sourceSnapshot, parseObject } = require('./workflow');
const { presentCase } = require('./decision-cases');

const ALLOWED_ACTIONS = new Set(['VERIFY_MORE', 'REPLAN', 'CONFIRM', 'ACCEPT_SUGGESTION', 'DEFER', 'DISMISS']);

/**
 * Validates and parses the structured response returned by an arbitrator.
 */
function parseArbitration(answer, referencesCount) {
    const raw = parseObject(answer);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('INVALID_ARBITRATION_FORMAT: Expected JSON object');
    }
    if (typeof raw.summary !== 'string' || !raw.summary.trim()) {
        throw new Error('INVALID_ARBITRATION_SUMMARY: summary is required');
    }
    if (!Array.isArray(raw.positions) || raw.positions.length === 0) {
        throw new Error('INVALID_ARBITRATION_POSITIONS: positions must be a non-empty array');
    }
    for (const pos of raw.positions) {
        if (!pos || typeof pos !== 'object') throw new Error('INVALID_POSITION_FORMAT');
        if (typeof pos.referenceIndex !== 'number' || !Number.isInteger(pos.referenceIndex) || pos.referenceIndex < 0 || pos.referenceIndex >= referencesCount) {
            throw new Error(`INVALID_REFERENCE_INDEX: referenceIndex ${pos.referenceIndex} out of bounds (0..${Math.max(0, referencesCount - 1)})`);
        }
        if (typeof pos.claim !== 'string' || !pos.claim.trim()) throw new Error('INVALID_POSITION_CLAIM: claim is required');
        if (typeof pos.support !== 'string' || !pos.support.trim()) throw new Error('INVALID_POSITION_SUPPORT: support is required');
        if (typeof pos.limitations !== 'string' || !pos.limitations.trim()) throw new Error('INVALID_POSITION_LIMITATIONS: limitations is required');
    }
    if (!Array.isArray(raw.options) || raw.options.length === 0) {
        throw new Error('INVALID_ARBITRATION_OPTIONS: options must be a non-empty array');
    }
    const optionIds = new Set();
    for (const opt of raw.options) {
        if (!opt || typeof opt !== 'object') throw new Error('INVALID_OPTION_FORMAT');
        if (typeof opt.id !== 'string' || !opt.id.trim()) throw new Error('INVALID_OPTION_ID: id is required');
        const idTrimmed = opt.id.trim();
        if (optionIds.has(idTrimmed)) throw new Error(`DUPLICATE_OPTION_ID: ${idTrimmed}`);
        optionIds.add(idTrimmed);
        if (!ALLOWED_ACTIONS.has(opt.action)) {
            throw new Error(`INVALID_OPTION_ACTION: action '${opt.action}' is not permitted; must be one of ${[...ALLOWED_ACTIONS].join(', ')}`);
        }
        if (typeof opt.reason !== 'string' || !opt.reason.trim()) throw new Error('INVALID_OPTION_REASON: reason is required');
        if (typeof opt.risks !== 'string' || !opt.risks.trim()) throw new Error('INVALID_OPTION_RISKS: risks is required');
    }

    if (raw.questions !== undefined && !Array.isArray(raw.questions)) {
        throw new Error('INVALID_ARBITRATION_QUESTIONS: questions must be an array');
    }
    const questions = [];
    const questionIds = new Set();
    for (const q of (raw.questions || [])) {
        if (!q || typeof q !== 'object') throw new Error('INVALID_QUESTION_FORMAT');
        if (typeof q.id !== 'string' || !q.id.trim()) throw new Error('INVALID_QUESTION_ID: id is required');
        const qId = q.id.trim();
        if (questionIds.has(qId)) throw new Error(`DUPLICATE_QUESTION_ID: ${qId}`);
        questionIds.add(qId);
        if (typeof q.text !== 'string' || !q.text.trim()) throw new Error('INVALID_QUESTION_TEXT: text is required');
        questions.push({ id: qId, text: q.text.trim() });
    }

    return {
        summary: raw.summary.trim(),
        positions: raw.positions.map(p => ({
            referenceIndex: p.referenceIndex,
            claim: p.claim.trim(),
            support: p.support.trim(),
            limitations: p.limitations.trim()
        })),
        options: raw.options.map(o => ({
            id: o.id.trim(),
            action: o.action,
            reason: o.reason.trim(),
            risks: o.risks.trim()
        })),
        questions
    };
}

/**
 * Builds the arbitration prompt.
 */
function buildArbitrationPrompt(caseRecord) {
    let p = `You are an independent technical arbitrator. Analyze the disagreement or uncertainty in the codebase READ-ONLY.\n`;
    p += `Workspace: ${caseRecord.workspaceRoot}\n`;
    p += `Dispute Title: ${caseRecord.title}\n`;
    p += `Core Question: ${caseRecord.question}\n\n`;
    if (caseRecord.anchor) {
        p += `Anchor Finding Under Dispute:\n${JSON.stringify(caseRecord.anchor.snapshot, null, 2)}\n\n`;
    }
    p += `Provided Evidence References (${caseRecord.references.length} items):\n`;
    caseRecord.references.forEach((ref, index) => {
        p += `[Reference ${index}] (${ref.kind} from ${ref.recordId}#${ref.itemId}):\n`;
        p += `${JSON.stringify(ref.snapshot, null, 2)}\n\n`;
    });
    p += `Analyze the dispute and return ONLY a single valid JSON object with this exact schema:\n`;
    p += `{\n`;
    p += `  "summary": "Clear explanation of why disagreement or trade-off exists",\n`;
    p += `  "positions": [\n`;
    p += `    {\n`;
    p += `      "referenceIndex": 0,\n`;
    p += `      "claim": "Summary of argument or stance",\n`;
    p += `      "support": "Concrete evidence supporting this position",\n`;
    p += `      "limitations": "Limitations or boundary conditions"\n`;
    p += `    }\n`;
    p += `  ],\n`;
    p += `  "options": [\n`;
    p += `    {\n`;
    p += `      "id": "O-1",\n`;
    p += `      "action": "VERIFY_MORE",\n`;
    p += `      "reason": "Why this action is recommended",\n`;
    p += `      "risks": "Remaining risks"\n`;
    p += `    }\n`;
    p += `  ],\n`;
    p += `  "questions": [\n`;
    p += `    {\n`;
    p += `      "id": "Q-1",\n`;
    p += `      "text": "Specific business or domain question for human"\n`;
    p += `    }\n`;
    p += `  ]\n`;
    p += `}\n\n`;
    p += `Rules:\n`;
    p += `1. 'action' MUST strictly be one of: VERIFY_MORE, REPLAN, CONFIRM, ACCEPT_SUGGESTION, DEFER, DISMISS. Never suggest directly closing a bug or an undefined action.\n`;
    p += `2. 'referenceIndex' MUST strictly refer to an index in the provided references list (0 to ${Math.max(0, caseRecord.references.length - 1)}).\n`;
    p += `3. Return raw JSON without markdown fences. Your response is advisory for humans; it does not directly apply triage or modify code.`;
    return p;
}

const fs = require('fs');
const path = require('path');

function defaultCatalog() {
    try {
        const cfgPath = path.resolve(__dirname, '..', 'models-config.json');
        if (fs.existsSync(cfgPath)) {
            return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        }
    } catch {}
    return { series: [], engineSeriesRules: {} };
}

function resolveCatalog(catalogOpt) {
    if (typeof catalogOpt === 'function') return catalogOpt();
    if (catalogOpt && typeof catalogOpt === 'object') return catalogOpt;
    return defaultCatalog();
}

/**
 * Runs single-shot arbitration for a decision case.
 */
async function analyzeCase(store, id, input = {}, options = {}) {
    if (!store || typeof store.read !== 'function') throw new Error('STORE_REQUIRED');
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('INVALID_RECORD_ID');

    const caseRecord = store.read('decision-cases', id);
    if (!input.workspaceRoot || workspaceKey(input.workspaceRoot) !== caseRecord.workspaceKey) {
        throw new Error('CASE_WORKSPACE_MISMATCH');
    }

    const presented = presentCase(store, id);
    if (presented.stale) {
        throw new Error('CASE_EVIDENCE_STALE: Case evidence or anchor is stale; cannot analyze');
    }
    if (input.version && input.version !== presented.version) {
        throw new Error('CASE_VERSION_CONFLICT: Case version conflict');
    }
    if (caseRecord.status === 'DECIDED') {
        throw new Error('CASE_ALREADY_DECIDED');
    }
    if (caseRecord.status === 'ANALYZING') {
        throw new Error('CASE_ALREADY_ANALYZING');
    }

    const catalog = resolveCatalog(options.catalog);
    const normalizedReviewer = normalizeReviewer(input.reviewer || { provider: 'mock' }, 0, catalog);
    ensureBudget(caseRecord, input.budget);

    let lease = null;
    if (store.guard && typeof store.guard.acquire === 'function') {
        lease = await store.guard.acquire({ kind: 'decision-analysis', id });
    }

    try {
        const snapshotFn = options.snapshot || sourceSnapshot;
        const preSnapshot = await snapshotFn(caseRecord.workspaceRoot, options.signal);

        startActiveTracking(caseRecord);
        caseRecord.status = 'ANALYZING';
        store.save('decision-cases', caseRecord);

        const prompt = buildArbitrationPrompt(caseRecord);
        const agentFn = options.agent || (p => invokeAgent(p));

        let parsedResult = null;
        let rawAnswer = '';
        let analysisStale = false;
        let analysisStaleReason = null;

        try {
            const stepId = `analysis-${crypto.randomUUID()}`;
            parsedResult = await trackedCall(caseRecord, {
                stepId,
                role: 'arbitration',
                provider: normalizedReviewer.provider,
                model: normalizedReviewer.model,
                reasoningEffort: normalizedReviewer.reasoningEffort,
                sessionId: crypto.randomUUID()
            }, {
                persist: () => store.save('decision-cases', caseRecord),
                signal: options.signal,
                invoke: async (attemptId) => {
                    rawAnswer = await agentFn({
                        workspaceRoot: caseRecord.workspaceRoot,
                        provider: normalizedReviewer.provider,
                        model: normalizedReviewer.model,
                        reasoningEffort: normalizedReviewer.reasoningEffort,
                        role: 'arbitration',
                        prompt,
                        signal: options.signal
                    });
                    return rawAnswer;
                },
                accept: async (answer) => {
                    const postSnapshot = await snapshotFn(caseRecord.workspaceRoot, options.signal);
                    if (postSnapshot !== preSnapshot) {
                        analysisStale = true;
                        analysisStaleReason = 'SOURCE_CHANGED_DURING_ANALYSIS';
                    }
                    const presentedNow = presentCase(store, id);
                    if (presentedNow.stale) {
                        analysisStale = true;
                        analysisStaleReason = analysisStaleReason || 'EVIDENCE_CHANGED_DURING_ANALYSIS';
                    }
                    return parseArbitration(answer, caseRecord.references.length);
                }
            });
        } catch (error) {
            const postPres = presentCase(store, id);
            caseRecord.status = postPres.stale ? 'NEEDS_REVIEW' : 'OPEN';
            store.save('decision-cases', caseRecord);
            throw error;
        }

        caseRecord.analysis = {
            analyzedAt: now(),
            reviewer: normalizedReviewer,
            summary: parsedResult.summary,
            positions: parsedResult.positions,
            options: parsedResult.options,
            questions: parsedResult.questions,
            stale: analysisStale,
            staleReason: analysisStaleReason,
            rawResponse: rawAnswer
        };

        caseRecord.status = analysisStale ? 'NEEDS_REVIEW' : 'AWAITING_HUMAN';
        store.save('decision-cases', caseRecord);

        return presentCase(store, id);
    } finally {
        stopActiveTracking(caseRecord);
        if (lease) {
            try { await lease.release(); } catch {}
        }
    }
}

module.exports = {
    ALLOWED_ACTIONS,
    parseArbitration,
    buildArbitrationPrompt,
    analyzeCase
};
