'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const now = () => new Date().toISOString();
function workspaceKey(workspace) {
    const resolved = fs.realpathSync(workspace);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function atomicJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp_${crypto.randomUUID()}`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(temp, file);
}
class RunStore {
    constructor(root) { this.root = path.resolve(root); }
    file(kind, id, name = 'state.json') {
        if (!['runs', 'plans', 'audits', 'discussions'].includes(kind) || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('INVALID_RECORD_ID');
        if (path.basename(name) !== name) throw new Error('INVALID_ARTIFACT_NAME');
        return path.join(this.root, kind, id, name);
    }
    read(kind, id) { return JSON.parse(fs.readFileSync(this.file(kind, id), 'utf8')); }
    save(kind, value) { value.updatedAt = now(); atomicJson(this.file(kind, value.id), value); return value; }
    list(kind, workspace) {
        if (!['runs', 'plans', 'audits', 'discussions'].includes(kind)) throw new Error('INVALID_RECORD_KIND');
        const dir = path.join(this.root, kind);
        if (!fs.existsSync(dir)) return [];
        const key = workspace ? workspaceKey(workspace) : null;
        return fs.readdirSync(dir).flatMap(id => {
            try { const r = this.read(kind, id); return !key || r.workspaceKey === key ? [r] : []; }
            catch { return []; }
        }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    event(run, type, detail = {}) {
        fs.appendFileSync(this.file('runs', run.id, 'events.jsonl'), JSON.stringify({ time: now(), type, ...detail }) + '\n');
    }
    createPlan(workspace, discussion) {
        return this.save('plans', { id: crypto.randomUUID(), workspaceRoot: fs.realpathSync(workspace),
            workspaceKey: workspaceKey(workspace), version: 1, status: 'AWAITING_APPROVAL',
            ...discussion, approval: null, createdAt: now() });
    }
    approvePlan(id, { version, text, workspaceRoot }) {
        const plan = this.read('plans', id);
        if (workspaceKey(workspaceRoot) !== plan.workspaceKey) throw new Error('PLAN_WORKSPACE_MISMATCH');
        if (version !== plan.version || plan.status !== 'AWAITING_APPROVAL') throw new Error('PLAN_VERSION_CONFLICT');
        if (typeof text !== 'string' || !text.trim()) throw new Error('EMPTY_PLAN');
        if(plan.planningId&&text.trim()!==plan.finalPlan)throw new Error('STRUCTURED_PLAN_REQUIRES_DECISION');
        // Preserve the generated draft as well as the exact human-approved revision.
        plan.draftPlan = plan.finalPlan;
        plan.finalPlan = text.trim();
        plan.version++;
        plan.status = 'APPROVED';
        plan.approval = { id: crypto.randomUUID(), version: plan.version, hash: hash(plan.finalPlan), approvedAt: now() };
        if(plan.planningId){plan.approval.requirementsHash=hash(JSON.stringify(plan.requirements));plan.approval.scopeHash=hash(plan.scope||'');}
        this.save('plans', plan);
        return plan;
    }
    approvedPlan(config) {
        const plan = this.read('plans', config.planId);
        if (plan.workspaceKey !== workspaceKey(config.workspaceRoot) || plan.status !== 'APPROVED' ||
            plan.approval?.id !== config.approvalId || plan.approval.hash !== hash(plan.finalPlan)) {
            throw new Error('PLAN_NOT_APPROVED');
        }
        if (config.taskPrompt && config.taskPrompt !== plan.finalPlan) throw new Error('APPROVED_PLAN_CHANGED');
        if(plan.planningId&&plan.approval.requirementsHash!==hash(JSON.stringify(plan.requirements)))throw new Error('APPROVED_PLAN_CHANGED');
        if(plan.approval.scopeHash&&plan.approval.scopeHash!==hash(plan.scope||''))throw new Error('APPROVED_PLAN_CHANGED');
        return plan;
    }
}
module.exports = { RunStore, hash, now, workspaceKey, atomicJson };
