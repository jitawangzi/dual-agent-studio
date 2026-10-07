'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CURRENT_STORAGE_VERSION, normalizeRecord, validateRecord } = require('./storage-schema');
const { RuntimeGuard } = require('./runtime-guard');

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
    constructor(root) {
        this.root = path.resolve(root);
        this.guard = new RuntimeGuard(this.root);
    }
    file(kind, id, name = 'state.json') {
        if (!['runs', 'plans', 'audits', 'discussions'].includes(kind) || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('INVALID_RECORD_ID');
        if (path.basename(name) !== name) throw new Error('INVALID_ARTIFACT_NAME');
        return path.join(this.root, kind, id, name);
    }
    read(kind, id) {
        const raw = JSON.parse(fs.readFileSync(this.file(kind, id), 'utf8'));
        const validation = validateRecord(kind, raw, id);
        if (!validation.ok) {
            throw new Error(`CORRUPTED_RECORD_STRUCTURE: ${validation.errors.map(e => e.code).join(', ')}`);
        }
        return normalizeRecord(kind, raw);
    }
    save(kind, value) {
        if (value.storageVersion > CURRENT_STORAGE_VERSION) throw new Error('UNSUPPORTED_STORAGE_VERSION');
        value.storageVersion = value.storageVersion ?? CURRENT_STORAGE_VERSION;
        value.updatedAt = now();
        atomicJson(this.file(kind, value.id), value);
        return value;
    }
    listWithDiagnostics(kind, workspace) {
        if (!['runs', 'plans', 'audits', 'discussions'].includes(kind)) throw new Error('INVALID_RECORD_KIND');
        const dir = path.join(this.root, kind);
        if (!fs.existsSync(dir)) return { records: [], errors: [] };
        const key = workspace ? workspaceKey(workspace) : null;
        const records = [];
        const errors = [];
        for (const id of fs.readdirSync(dir)) {
            let file;
            try {
                file = this.file(kind, id);
            } catch (err) {
                errors.push({ kind, id, path: path.join(dir, id), code: 'INVALID_RECORD_ID', message: err.message });
                continue;
            }
            try {
                if (!fs.existsSync(file)) {
                    errors.push({ kind, id, path: file, code: 'FILE_NOT_FOUND', message: 'Record file does not exist' });
                    continue;
                }
                const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                    errors.push({ kind, id, path: file, code: 'CORRUPTED_RECORD_STRUCTURE', message: 'Record is not an object' });
                    continue;
                }
                if (raw.storageVersion > CURRENT_STORAGE_VERSION) {
                    errors.push({ kind, id, path: file, code: 'UNSUPPORTED_STORAGE_VERSION', message: `storageVersion ${raw.storageVersion} exceeds supported version ${CURRENT_STORAGE_VERSION}` });
                    continue;
                }
                const validation = validateRecord(kind, raw, id);
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
                const normalized = normalizeRecord(kind, raw);
                if (!key || normalized.workspaceKey === key) {
                    records.push(normalized);
                }
            } catch (err) {
                errors.push({ kind, id, path: file, code: 'CORRUPTED_RECORD', message: err.message });
            }
        }
        records.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
        return { records, errors };
    }
    list(kind, workspace) {
        return this.listWithDiagnostics(kind, workspace).records;
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
