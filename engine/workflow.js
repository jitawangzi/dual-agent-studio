'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execute, invokeAgent } = require('./process-runner');
const { trackedCall, interruptOpenAttempts } = require('./call-ledger');
const { ensureBudget, startActiveTracking, stopActiveTracking, recoverBudget } = require('./execution-budget');
const { hash, now, workspaceKey } = require('./run-store');
const {trackProgress,parseTargetedReview}=require('./review-progress');

const {evidenceRefs,coverageDetails,evidenceInstructions}=require('./review-evidence');

const CLOSED = 'VERIFIED_CLOSED';
const TERMINAL = ['APPROVED', 'FAILED', 'STOPPED', 'INTERRUPTED', 'NEEDS_ATTENTION', 'REJECTED_MAX_ROUNDS'];
function parseObject(text) {
    const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let result;
    try { result = JSON.parse(clean); } catch { throw new Error('INVALID_AGENT_JSON: 必须返回完整 JSON 对象'); }
    if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error('INVALID_AGENT_JSON');
    return result;
}
function requiredText(value, field) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`INVALID_REVIEW: ${field} is required`);
    return value.trim();
}
function applyReview(run, report, snapshot) {
    if (!['APPROVED', 'REJECTED', 'NEEDS_DECISION'].includes(report.verdict) ||
        !Array.isArray(report.issues) || !Array.isArray(report.verifications) ||
        !Array.isArray(report.coverage) || typeof report.scopeComplete !== 'boolean') throw new Error('INVALID_REVIEW_SCHEMA');
    requiredText(report.summary, 'summary');
    if (report.scopeComplete && !report.coverage.length) throw new Error('REVIEW_COVERAGE_MISSING');
    for (const item of report.coverage) requiredText(item, 'coverage');
    report.coverageDetails=coverageDetails(report.coverageDetails,report.scopeComplete);
    for(const item of [...report.issues,...report.verifications,...(report.acceptanceChecks||[])]) item.evidenceRefs=evidenceRefs(item.evidenceRefs,run.testGate,snapshot);
    const seen = new Set();
    let added = 0, reopened = 0;
    for (const finding of report.issues) {
        const file = requiredText(finding.file, 'file').replace(/\\/g, '/');
        const problem = requiredText(finding.problem, 'problem');
        const evidence = requiredText(finding.evidence, 'evidence');
        const acceptance = requiredText(finding.acceptance, 'acceptance');
        if (!['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(finding.severity)) throw new Error('INVALID_SEVERITY');
        const fingerprint = hash(`${file.toLowerCase()}\n${problem.toLowerCase().replace(/\s+/g, ' ')}`);
        let bug = finding.id ? run.bugs.find(b => b.id === finding.id) : run.bugs.find(b => b.fingerprint === fingerprint);
        if (finding.id && !bug) throw new Error('UNKNOWN_BUG_ID');
        if (!bug) {
            bug = { id: `BUG-${String(run.bugs.length + 1).padStart(4, '0')}`, fingerprint,
                firstSeenRound: run.round, status: 'OPEN', history: [] };
            run.bugs.push(bug); added++;
        } else if (bug.status === CLOSED) { reopened++; bug.status = 'REOPENED'; }
        else { bug.status = 'OPEN'; }
        if (seen.has(bug.id)) throw new Error('DUPLICATE_FINDING');
        seen.add(bug.id);
        Object.assign(bug, { evidenceRefs:finding.evidenceRefs, file, problem, evidence, acceptance, severity: finding.severity,
            lineRange: String(finding.lineRange || ''), fixSuggestion: String(finding.fixSuggestion || ''), lastSeenRound: run.round });
        bug.history.push({ round: run.round, status: bug.status, evidence, evidenceRefs:finding.evidenceRefs, snapshot, at: now() });
    }
    const verified = new Set();
    for (const check of report.verifications) {
        const bug = run.bugs.find(b => b.id === check.id);
        if (!bug || verified.has(check.id) || seen.has(check.id)) throw new Error('INVALID_BUG_VERIFICATION');
        verified.add(check.id);
        const evidence = requiredText(check.evidence, 'verification evidence');
        if (!['RESOLVED', 'UNRESOLVED', 'DISPUTED'].includes(check.result)) throw new Error('INVALID_VERIFICATION_RESULT');
        // An omitted finding is never considered fixed. Only the reviewer can close it,
        // and only after the test gate passed on this exact source snapshot.
        const canClose = run.testGate?.status === 'PASS' && run.testGate.snapshot === snapshot;
        if (check.result === 'RESOLVED' && !canClose) throw new Error('UNVERIFIED_BUG_CLOSURE');
        bug.status = check.result === 'RESOLVED' ? CLOSED : check.result === 'DISPUTED' ? 'DISPUTED' : 'OPEN';
        bug.history.push({ round: run.round, status: bug.status, evidence, evidenceRefs:check.evidenceRefs, snapshot, at: now() });
    }
    const pending = run.bugs.filter(b => b.status !== CLOSED);
    let criteriaPassed=true,criteriaBlocked=false;
    if(run.acceptanceCriteria?.length){
        const checks=report.acceptanceChecks;
        if(!Array.isArray(checks)||checks.length!==run.acceptanceCriteria.length)throw new Error('INCOMPLETE_ACCEPTANCE_CHECKS');
        const checked=new Set();
        for(const check of checks){
            if(!run.acceptanceCriteria.some(c=>c.id===check.id)||checked.has(check.id)||!['PASS','FAIL','BLOCKED'].includes(check.result))throw new Error('INVALID_ACCEPTANCE_CHECK');
            requiredText(check.evidence,'acceptance evidence');checked.add(check.id);
            criteriaPassed&&=check.result==='PASS';criteriaBlocked||=check.result==='BLOCKED';
        }
        if(report.acceptanceComplete!==criteriaPassed)throw new Error('CONTRADICTORY_ACCEPTANCE_RESULT');
    }
    if (run.mode === 'plan' && typeof report.acceptanceComplete !== 'boolean') throw new Error('PLAN_ACCEPTANCE_MISSING');
    const clean = criteriaPassed && report.verdict === 'APPROVED' && report.scopeComplete && (run.mode !== 'plan' || report.acceptanceComplete) && !pending.length && !added && !reopened &&
        run.testGate?.status === 'PASS' && run.testGate.snapshot === snapshot;
    run.cleanRounds = clean ? run.cleanRounds + 1 : 0;
    run.lastReview = { ...report, snapshot, added, reopened, pending: pending.length, approval: run.approval, at: now() };
    run.history.push({ round: run.round, devSubmission: run.currentDevSubmission,
        reviewVerdict: { ...report, verdict: clean ? 'APPROVED' : 'REJECTED' }, snapshot, approval: run.approval, acceptanceCriteria: run.acceptanceCriteria, testGate:run.testGate, changeEvidence:run.changeEvidence, reviewArtifact:run.lastResponseArtifact });
    return { clean, pending, needsDecision: criteriaBlocked || report.verdict === 'NEEDS_DECISION' || pending.some(b => b.status === 'DISPUTED') };
}
async function git(workspace, args, signal) {
    return execute('git', args, { cwd: workspace, signal, timeoutMs: 60000 });
}
const { computeLegacySnapshot } = require('./source-manifest');
async function sourceSnapshot(workspace, signal) {
    return computeLegacySnapshot(workspace, signal);
}

class Workflow {
    constructor(store, { agent = invokeAgent, command = execute, snapshot = sourceSnapshot, emit = () => {} } = {}) {
        this.store = store; this.agent = agent; this.command = command; this.snapshot = snapshot; this.emit = emit;
        this.active = null;
    }
    recover() {
        for (const run of this.store.list('runs')) {
            let changed = false;
            if (['RUNNING', 'CREATED'].includes(run.status)) {
                run.status = 'INTERRUPTED'; run.error = '服务重启；恢复时会重新测试和审查当前代码。';
                interruptOpenAttempts(run);
                changed = true;
            }
            if (recoverBudget(run)) changed = true;
            if (changed) this.save(run, 'interrupted');
        }
    }
    save(run, type, detail = {}) {
        this.store.save('runs', run);
        this.store.event(run, type, { phase: run.phase, round: run.round, ...detail });
        this.emit('run_update', run);
    }
    create(config) {
        if (this.active) throw new Error('WORKFLOW_BUSY');
        const workspaceRoot = fs.realpathSync(requiredText(config.workspaceRoot, 'workspaceRoot'));
        if (!fs.statSync(workspaceRoot).isDirectory()) throw new Error('WORKSPACE_NOT_FOUND');
        const mode = config.mode || 'direct';
        if (!['plan', 'audit', 'direct'].includes(mode)) throw new Error('INVALID_WORKFLOW_MODE');
        const plan = mode === 'plan' ? this.store.approvedPlan({ ...config, workspaceRoot }) : null;
        const taskPrompt = plan ? plan.finalPlan : requiredText(config.taskPrompt, 'taskPrompt');
        const int = (value, fallback, max) => {
            const n = value === undefined ? fallback : Number(value);
            if (!Number.isInteger(n) || n < 1 || n > max) throw new Error('INVALID_RUN_LIMIT');
            return n;
        };
        const normalized = { workspaceRoot, mode, taskPrompt,
            feature: String(config.feature || (mode === 'audit' ? '工程审查与修复' : '方案实施')),
            scope: String(plan?.scope || config.scope || '整个工程：自有源码、测试、配置；排除依赖、构建产物与生成文件'),
            verifyCommand: requiredText(config.verifyCommand, 'verifyCommand'),
            maxRounds: int(config.maxRounds, 6, 50), cleanRoundsRequired: int(config.cleanRoundsRequired, 2, 5),
            maxSelfHealAttempts: int(config.maxSelfHealAttempts, 3, 10),
            maxNoProgressRounds: int(config.maxNoProgressRounds, 3, 10),
            timeoutSeconds: int(config.timeoutSeconds, 1200, 7200),
            autoCommit: config.autoCommit === true,
            devProvider: config.devProvider || 'claude', reviewProvider: config.reviewProvider || 'copilot',
            devModel: String(config.devModel || ''), reviewModel: String(config.reviewModel || ''),
            devReasoningEffort: String(config.devReasoningEffort || ''), reviewReasoningEffort: String(config.reviewReasoningEffort || ''),
            devSessionId: crypto.randomUUID(), reviewSessionId: crypto.randomUUID() };
        if (normalized.maxRounds < normalized.cleanRoundsRequired) throw new Error('MAX_ROUNDS_BELOW_CLEAN_ROUNDS');
        if (/^\s*(exit\s+0|true|echo\s+.*)\s*;?\s*$/i.test(normalized.verifyCommand)) throw new Error('REAL_TEST_COMMAND_REQUIRED');
        const supported = ['claude', 'copilot', 'codex', 'antigravity', 'aider', 'pi', 'cursor', 'mock'];
        if (![normalized.devProvider, normalized.reviewProvider].every(p => supported.includes(p))) throw new Error('UNSUPPORTED_PROVIDER');
        const run = { id: crypto.randomUUID(), schemaVersion: '2.0', workspaceRoot, workspaceKey: workspaceKey(workspaceRoot),
            config: normalized, mode, feature: normalized.feature, taskPrompt, status: 'CREATED',
            phase: mode === 'audit' ? 'TEST' : 'DEV', round: 1, maxRounds: normalized.maxRounds,
            cleanRounds: 0, bugs: [], history: [], currentDevSubmission: null, testGate: null,
            devSessionId: normalized.devSessionId, reviewSessionId: normalized.reviewSessionId,
            approval: plan ? { planId: plan.id, ...plan.approval } : null, failures: 0,
            acceptanceCriteria:plan?.requirements||[],planSourceSnapshot:plan?.sourceSnapshot||null,
            createdAt: now(), error: '', lastReview: null };
        ensureBudget(run, config.budget);
        this.save(run, 'created');
        return run;
    }
    launch(run) {
        if (this.active || this.store?.guard?.isBusy()) throw new Error('WORKFLOW_BUSY');
        const controller = new AbortController();
        const lease = this.store?.guard ? this.store.guard.acquire({ kind: 'run', id: run.id, workspaceKey: run.workspaceKey }) : null;
        this.active = { id: run.id, controller, promise: null, lease }; run.status = 'RUNNING'; run.error = '';


        this.active.promise = (async () => {
            try {
                if (lease) await lease;
                if (controller.signal.aborted) throw new Error('RUN_CANCELLED');

                startActiveTracking(run);
                this.save(run, 'started');
                await this.drive(run, controller.signal);
            } catch (err) {
                if (err.code === 'BUDGET_EXHAUSTED' || /BUDGET_EXHAUSTED/.test(err.message)) {
                    run.status = 'STOPPED';
                    run.pauseReason = 'BUDGET_EXHAUSTED';
                    run.allowedActions = ['INCREASE_BUDGET', 'MANUAL_RESUME'];
                    run.error = err.message;
                    this.save(run, 'budget_exhausted');
                } else {
                    run.status = controller.signal.aborted ? 'STOPPED' : 'FAILED'; run.error = err.message;
                    this.save(run, 'failed');
                }
            }
        })().finally(() => {
            stopActiveTracking(run);
            try { this.save(run, 'stopped_tracking'); } catch {}
            this.active?.lease?.release?.();
            this.active = null; this.emit('run_idle', { id: run.id });
        });
        return run;
    }
    resume(id) {
        if (this.active) throw new Error('WORKFLOW_BUSY');
        const run = this.store.read('runs', id);
        if (!['STOPPED', 'FAILED', 'INTERRUPTED'].includes(run.status)) throw new Error('RUN_NOT_RESUMABLE');
        if (run.activePid) {
            let alive = false;
            try { process.kill(run.activePid, 0); alive = true; } catch (error) { if (error.code !== 'ESRCH') alive = true; }
            if (alive) throw new Error(`PREVIOUS_PROCESS_STILL_RUNNING: ${run.activePid}，请先确认旧进程已结束。`);
            run.activePid = null;
        }
        if (run.round > run.maxRounds) throw new Error('RUN_BUDGET_EXHAUSTED');
        // Never replay an interrupted mutation automatically: inspect the current files first.
        run.resumeFrom = run.phase; run.phase = 'TEST'; run.cleanRounds = 0; run.failures = 0;
        return this.launch(run);
    }
    async stop() {
        const active = this.active;
        if (active) { active.controller.abort(); await active.promise.catch(() => {}); active.lease?.release?.(); }
    }
    decide(id, { note, extraRounds = 4, planId, approvalId }) {
        if (this.active) throw new Error('WORKFLOW_BUSY');
        const run = this.store.read('runs', id);
        if (!['NEEDS_ATTENTION', 'REJECTED_MAX_ROUNDS'].includes(run.status)) throw new Error('RUN_NOT_AWAITING_DECISION');
        requiredText(note, 'human decision');
        if (!Number.isInteger(extraRounds) || extraRounds < 1 || extraRounds > 20) throw new Error('INVALID_RUN_LIMIT');
        if (run.mode === 'plan') {
            // Human decisions cannot silently expand a previously approved plan.
            const plan = this.store.approvedPlan({ workspaceRoot: run.workspaceRoot, planId, approvalId });
            if(run.approval?.planId!==plan.id){run.planSourceSnapshot=plan.sourceSnapshot||null;run.planSourceValidated=false;run.lastReview=null;}
            if(plan.scope)run.config.scope=plan.scope;
            run.acceptanceCriteria=plan.requirements||[];
            run.taskPrompt = plan.finalPlan; run.config.taskPrompt = plan.finalPlan;
            run.approval = { planId: plan.id, ...plan.approval };
        }
        run.decisions = [...(run.decisions || []), { note: note.trim(), at: now(), approval: run.approval }];
        run.progressCheckpoint=null;run.attention=null;
        run.round++; run.maxRounds = run.round + extraRounds - 1;
        run.config.maxRounds = run.maxRounds;
        run.phase = 'TEST'; run.resumeFrom = 'HUMAN_DECISION'; run.cleanRounds = 0; run.failures = 0;
        this.save(run, 'human_decision', { note });
        return this.launch(run);
    }
    async call(run, role, prompt, signal, accept = value => value) {
        if (signal.aborted) throw new Error('RUN_CANCELLED');
        const prefix = role === 'review' ? 'review' : 'dev';
        const invocation = `${run.round}-${role}-${crypto.randomUUID()}`;
        const artifact = name => this.store.file('runs', run.id, `${invocation}.${name}`);
        fs.writeFileSync(artifact('prompt.txt'), prompt);
        const request = { provider: run.config[`${prefix}Provider`], model: run.config[`${prefix}Model`],
            reasoningEffort: run.config[`${prefix}ReasoningEffort`], sessionId: run[`${prefix}SessionId`],
            workspaceRoot: run.workspaceRoot, role, prompt, sessionDirectory: path.join(this.store.root, 'sessions') };
        // Ledger checkpoints: before the provider, after output, after validation (accept).
        const meta = { stepId: `round-${run.round}:${run.phase}`, role, phase: run.phase, provider: request.provider,
            model: request.model, reasoningEffort: request.reasoningEffort, sessionId: request.sessionId };
        return trackedCall(run, meta, { signal, accept, persist: () => this.save(run, 'call_ledger'),
            invoke: async (attemptId, innerSignal) => {
                let response;
                const effectiveSignal = innerSignal || signal;
                try { response = await this.agent(request, { signal: effectiveSignal, timeoutMs: run.config.timeoutSeconds * 1000,
                    onOutput: (text, stream) => {
                        fs.appendFileSync(artifact('log.txt'), text);
                        this.emit('log', { time: now(), type: stream, message: text, runId: run.id });
                    }, onSpawn: proc => { run.activePid = proc.pid; this.save(run, 'process_started', { pid: proc.pid, invocation }); } });
                } finally { run.activePid = null; }
                if (effectiveSignal.aborted) throw effectiveSignal.reason || new Error('RUN_CANCELLED');
                fs.writeFileSync(artifact('response.txt'), response);
                run.lastResponseArtifact=path.basename(artifact('response.txt'));
                return response;
            } });
    }
    reviewPrompt(run, snapshot) {
        return `You are the independent reviewer. Read the actual project files in ${run.workspaceRoot}.
This is a READ-ONLY review. Do not modify files, commit, or delegate edits. Do not trust the developer's claims.
Mode: ${run.mode}. Scope: ${run.config.scope}
Task / approved requirements: ${run.taskPrompt}
Structured acceptance criteria: ${JSON.stringify(run.acceptanceCriteria||[])}
${run.acceptanceCriteria?.length?'For EVERY structured criterion return acceptanceChecks [{id,result:"PASS|FAIL|BLOCKED",evidence:"concrete source/test evidence"}]. Every ID exactly once. acceptanceComplete is true only if every criterion is PASS; insufficient business information is BLOCKED. Do not fabricate test execution.':''}
Human decisions (review the evidence, do not close bugs merely on instruction): ${JSON.stringify(run.decisions || [])}
Source snapshot: ${snapshot}
Audit the existing source even if there is NO git diff. Check regressions and new bugs across the stated scope.
${run.mode === 'plan' ? 'Verify all approved acceptance criteria. If the scope must change, return NEEDS_DECISION with reasons; do not extend the approved plan.' : ''}
Known bug inventory (reuse IDs; re-report a closed bug with its ID if it regresses):
${JSON.stringify(run.bugs)}
Latest test evidence: ${JSON.stringify(run.testGate)}
Developer report (untrusted): ${JSON.stringify(run.currentDevSubmission)}
Targeted verification of this source (independent evidence, still check regressions): ${JSON.stringify(run.targetedReview?.snapshot===snapshot?run.targetedReview:null)}
For EVERY non-closed bug, provide a verification with concrete code/test evidence. Omission does NOT close a bug.
Only mark RESOLVED when its acceptance condition is actually satisfied. Disagreements/false-positive claims use DISPUTED.
${evidenceInstructions}
List actual files/modules inspected in coverage. scopeComplete must be false if coverage or required validation is incomplete.
Return ONLY JSON:
{"verdict":"APPROVED|REJECTED|NEEDS_DECISION","summary":"...","scopeComplete":true,"acceptanceComplete":true,"coverage":["files inspected and checks performed; acceptance criteria and their evidence"],
"issues":[{"file":"relative path","lineRange":"10-20","severity":"LOW|MEDIUM|HIGH|CRITICAL","problem":"...","evidence":"reproduction or code evidence","acceptance":"how to prove fixed","fixSuggestion":"..."}],
"verifications":[{"id":"BUG-0001","result":"RESOLVED|UNRESOLVED|DISPUTED","evidence":"..."}]}
Do not list the same bug in both issues and verifications. APPROVED requires no outstanding confirmed bugs and complete scope.`;
    }
    async drive(run, signal) {
        try {
            if(run.planSourceSnapshot&&!run.planSourceValidated){
                if(await this.snapshot(run.workspaceRoot,signal)!==run.planSourceSnapshot)throw new Error('APPROVED_PLAN_SOURCE_CHANGED');
                run.planSourceValidated=true;this.save(run,'approved_source_checked');
            }
            if (run.baselineClean === undefined) {
                const status = await git(run.workspaceRoot, ['status', '--porcelain'], signal);
                run.baselineClean = status.code === 0 && !status.stdout.trim();
                if (run.config.autoCommit && !run.baselineClean) throw new Error('AUTO_COMMIT_REQUIRES_CLEAN_WORKSPACE');
            }
            while (run.round <= run.maxRounds) {
                if (signal.aborted) throw new Error('RUN_CANCELLED');
                this.save(run, 'phase');
                if (run.phase === 'DEV') {
                    const beforeDev=await this.snapshot(run.workspaceRoot,signal);
                    const prompt = `Implement the task in ${run.workspaceRoot}. Do not commit or push.
Task / approved plan: ${run.taskPrompt}
Human decisions: ${JSON.stringify(run.decisions || [])}
Scope: ${run.config.scope}
${run.mode === 'plan' ? 'Implement ONLY the human-approved plan. If it requires scope changes, return JSON {"needsDecision":true,"summary":"reason and proposed change"} without extending scope.' : ''}
Fix the outstanding bugs; add regression tests where appropriate. Never close bugs yourself.
${JSON.stringify(run.bugs.filter(b => b.status !== CLOSED))}
Last independent review: ${JSON.stringify(run.lastReview)}
Last test evidence: ${JSON.stringify(run.testGate)}
Return ONLY JSON {"summary":"changes and validation","needsDecision":false,"fixes":[{"id":"BUG-0001","summary":"fix or disagreement evidence"}]}.`;
                    const submission = await this.call(run, 'dev', prompt, signal, parseObject);
                    requiredText(submission.summary, 'developer summary');
                    if (typeof submission.needsDecision !== 'boolean' || (!submission.needsDecision && !Array.isArray(submission.fixes))) throw new Error('INVALID_DEV_SCHEMA');
                    run.currentDevSubmission = submission;
                    const afterDev=await this.snapshot(run.workspaceRoot,signal);
                    let diff;
                    try { diff=await git(run.workspaceRoot,['diff','HEAD','--'],signal); }
                    catch(error) { if(signal.aborted)throw error;diff={code:null,stderr:error.message}; }
                    const diffArtifact=`changes-${run.round}-${crypto.randomUUID()}.txt`;
                    fs.writeFileSync(this.store.file('runs',run.id,diffArtifact),diff.code===0?diff.stdout:'Git diff unavailable: '+diff.stderr);
                    run.changeEvidence={beforeSnapshot:beforeDev,afterSnapshot:afterDev,artifact:diffArtifact,available:diff.code===0,limitations:'Diff is against HEAD, includes pre-existing tracked changes, and excludes untracked files. Snapshot fingerprints identify before/after source states, not a standalone patch.'};
                    if (submission.needsDecision) { run.status = 'NEEDS_ATTENTION'; run.error = submission.summary; break; }
                    for (const bug of run.bugs.filter(b => b.status !== CLOSED)) bug.status = 'AWAITING_VERIFICATION';
                    run.phase = 'TEST'; this.save(run, 'dev_completed');
                }
                if (run.phase === 'TEST') {
                    const before = await this.snapshot(run.workspaceRoot, signal);
                    if (run.lastReview && run.lastReview.snapshot !== before) run.cleanRounds = 0;
                    const result = await this.command('pwsh', ['-NoProfile', '-Command', run.config.verifyCommand], {
                        cwd: run.workspaceRoot, signal, timeoutMs: run.config.timeoutSeconds * 1000,
                        onSpawn: proc => { run.activePid = proc.pid; this.save(run, 'test_process_started', { pid: proc.pid }); },
                        onOutput: (text, type) => this.emit('log', { time: now(), type, message: text, runId: run.id }) });
                    run.activePid = null;
                    const after = await this.snapshot(run.workspaceRoot, signal);
                    const output = `${result.stdout}\n${result.stderr}`;
                    const testArtifact=`tests-${run.round}-${run.failures}-${crypto.randomUUID()}.txt`;
                    fs.writeFileSync(this.store.file('runs', run.id, testArtifact), output);
                    run.testGate = { status: result.code === 0 && before === after ? 'PASS' : 'FAIL', exitCode: result.code,
                        artifact:testArtifact, truncated:output.length>16000, beforeSnapshot:before, snapshot: after, command: run.config.verifyCommand, output: output.slice(-16000), at: now(),
                        sourceChanged: before !== after };
                    if (run.currentDevSubmission) run.currentDevSubmission.testGateStatus = run.testGate.status;
                    // On the initial audit and on recovery, always inspect before allowing a mutation.
                    if (run.testGate.status !== 'PASS' && !(run.mode === 'audit' && !run.lastReview) && !run.resumeFrom) {
                        run.cleanRounds = 0; run.failures++;
                        if (run.failures >= run.config.maxSelfHealAttempts) {
                            run.status='NEEDS_ATTENTION';run.error='TEST_GATE_SELF_HEAL_EXCEEDED: 测试连续失败，请查看输出并调整方案后继续。';
                            run.attention={reason:'TEST_GATE_STALLED',summary:run.error,testGate:run.testGate,attempts:run.failures};break;
                        }
                        run.phase = 'DEV'; this.save(run, 'test_failed'); continue;
                    }
                    for(const bug of run.bugs)if(bug.status===CLOSED&&bug.history?.at(-1)?.snapshot!==after){
                        bug.status='AWAITING_VERIFICATION';bug.history||=[];
                        bug.history.push({round:run.round,status:bug.status,snapshot:after,at:now(),evidence:'源码已变化，先前关闭证据需要在当前版本重新验证。'});
                    }
                    run.resumeFrom = null; run.phase = run.sourceAudit&&run.bugs.some(b=>b.status!==CLOSED)?'TARGET_REVIEW':'REVIEW'; this.save(run, 'test_completed');
                }
                if(run.phase==='TARGET_REVIEW'){
                    const before=await this.snapshot(run.workspaceRoot,signal);
                    if(before!==run.testGate.snapshot)throw new Error('SOURCE_CHANGED_AFTER_TEST');
                    const pending=run.bugs.filter(b=>b.status!==CLOSED);
                    const diff=await git(run.workspaceRoot,['diff','HEAD','--'],signal);
                    const changes=diff.code===0?diff.stdout.slice(0,32000):'Git diff unavailable (possibly no commits or not a Git repository); inspect actual files.';
                    const prompt=`TARGETED_REPAIR_REVIEW: Read-only independent verification in ${run.workspaceRoot}. Do not edit, commit or delegate fixes.
For EACH listed issue, inspect its original trigger, acceptance condition, changed source and regression tests. Do not trust developer claims or equate a passing test command with proof. Missing/insufficient evidence means UNRESOLVED; business or design disagreement means DISPUTED. The overall regression review happens separately afterwards.
Source fingerprint: ${before}
Original audit and verification evidence: ${JSON.stringify(run.sourceAudit)}
Issues to verify (exact IDs required): ${JSON.stringify(pending)}
Test evidence: ${JSON.stringify(run.testGate)}
Developer claims: ${JSON.stringify(run.currentDevSubmission)}
Human decisions: ${JSON.stringify(run.decisions||[])}
Git diff against HEAD (at most 32000 characters; untracked files are not included, inspect them as needed):
${changes}
${evidenceInstructions}
Return ONLY JSON {"summary":"checks and limitations","verifications":[{"id":"BUG-0001","result":"RESOLVED|UNRESOLVED|DISPUTED","evidence":"concrete source/test evidence for this acceptance condition"}]}. Include every requested ID exactly once. No new issue IDs in this step.`;
                    const report=await this.call(run,'review',prompt,signal,text=>parseTargetedReview(parseObject(text),pending,run.testGate,before));
                    if(before!==await this.snapshot(run.workspaceRoot,signal))throw new Error('SOURCE_CHANGED_DURING_REVIEW');
                    if(report.verifications.some(v=>v.result==='RESOLVED')&&run.testGate.status!=='PASS')throw new Error('UNVERIFIED_BUG_CLOSURE');
                    run.targetedReview={...report,responseArtifact:run.lastResponseArtifact,snapshot:before,round:run.round,at:now()};
                    run.targetedReviewHistory||=[];run.targetedReviewHistory.push(run.targetedReview);
                    this.save(run,'targeted_review_completed');
                    if(report.verifications.some(v=>v.result==='DISPUTED')){
                        for(const check of report.verifications.filter(v=>v.result==='DISPUTED')){
                            const bug=run.bugs.find(b=>b.id===check.id);bug.status='DISPUTED';bug.history.push({round:run.round,status:'DISPUTED',evidence:check.evidence,snapshot:before,at:now()});
                        }
                        run.status='NEEDS_ATTENTION';run.error='定向复查存在争议，请查看逐项证据并决定下一步。';
                        run.attention={reason:'TARGETED_DISPUTE',summary:run.error,verifications:report.verifications};break;
                    }
                    run.phase='REVIEW';this.save(run,'regression_review_started');
                }
                if (run.phase === 'REVIEW') {
                    const before = await this.snapshot(run.workspaceRoot, signal);
                    if (before !== run.testGate.snapshot) throw new Error('SOURCE_CHANGED_AFTER_TEST');
                    const report = await this.call(run, 'review', this.reviewPrompt(run, before), signal, parseObject);
                    if (before !== await this.snapshot(run.workspaceRoot, signal)) throw new Error('SOURCE_CHANGED_DURING_REVIEW');
                    if(run.sourceAudit){
                        for(const check of report.verifications||[])if(check.result==='RESOLVED'&&run.bugs.some(b=>b.id===check.id&&b.status!==CLOSED)){
                            if(run.targetedReview?.snapshot!==before||run.targetedReview.round!==run.round||!run.targetedReview.verifications.some(v=>v.id===check.id&&v.result==='RESOLVED'))throw new Error('TARGETED_VERIFICATION_REQUIRED');
                        }
                    }
                    // Apply atomically in memory too: a malformed partial report must not close bugs.
                    const candidate = JSON.parse(JSON.stringify(run));
                    const outcome = applyReview(candidate, report, before);
                    const noProgress=trackProgress(candidate,outcome,before);
                    Object.assign(run, candidate);
                    if (run.currentDevSubmission) run.currentDevSubmission = null;
                    this.save(run, 'review_completed');
                    if (outcome.needsDecision) { run.status = 'NEEDS_ATTENTION'; run.error = report.summary; run.attention={reason:'REVIEW_DISPUTE',summary:report.summary}; break; }
                    if(noProgress){run.status='NEEDS_ATTENTION';run.error=run.attention.summary;break;}
                    if (run.cleanRounds >= run.config.cleanRoundsRequired) {
                        if (run.config.autoCommit) {
                            const add = await git(run.workspaceRoot, ['add', '-A'], signal);
                            if (add.code !== 0) throw new Error('GIT_ADD_FAILED: ' + add.stderr);
                            if (before !== await this.snapshot(run.workspaceRoot, signal)) throw new Error('SOURCE_CHANGED_BEFORE_COMMIT');
                            const staged = await git(run.workspaceRoot, ['diff', '--cached', '--quiet'], signal);
                            if (staged.code === 1) {
                                const commit = await git(run.workspaceRoot, ['commit', '-m', `fix: ${run.feature} (dual-agent verified)`], signal);
                                if (commit.code !== 0) throw new Error('GIT_COMMIT_FAILED: ' + commit.stderr);
                                run.commit = commit.stdout;
                            } else if (staged.code !== 0) throw new Error('GIT_STATUS_FAILED');
                        }
                        run.status = 'APPROVED'; run.phase = 'COMPLETE'; break;
                    }
                    if (run.round === run.maxRounds) { run.status = 'REJECTED_MAX_ROUNDS'; run.error = '达到审查轮数上限；尚未满足全部完成条件。'; break; }
                    run.round++;
                    // A clean pass needs another independent review, not another code edit.
                    run.phase = outcome.clean ? 'TEST' : 'DEV';
                    run.failures = 0;
                    this.save(run, 'round_advanced');
                }
            }
        } catch (error) {
            if (error.code === 'BUDGET_EXHAUSTED' || /BUDGET_EXHAUSTED/.test(error.message)) {
                run.status = 'STOPPED';
                run.pauseReason = 'BUDGET_EXHAUSTED';
                run.allowedActions = ['INCREASE_BUDGET', 'MANUAL_RESUME'];
                run.error = error.message;
            } else {
                run.status = signal.aborted ? 'STOPPED' : 'FAILED'; run.error = error.message;
            }
        } finally {
            if (signal.aborted && run.status !== 'APPROVED') run.status = 'STOPPED';
            this.save(run, 'finished', { status: run.status, error: run.error });
        }
        return run;
    }
}
module.exports = { Workflow, parseObject, applyReview, sourceSnapshot, TERMINAL };
