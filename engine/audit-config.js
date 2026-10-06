'use strict';
const {normalizeChecklist}=require('./audit-assignment');

// Only adapters that restrict review tools are offered in the first release.
const PROVIDERS = [
    { id: 'claude', name: 'Claude Code', accepts: value => /^(low|medium|high|xhigh|max|\d+)$/.test(value) },
    { id: 'copilot', name: 'GitHub Copilot', accepts: value => /^(low|medium|high|xhigh|max|none|minimal)$/.test(value) },
    { id: 'codex', name: 'Codex CLI', accepts: value => /^(low|medium|high|xhigh|max|none|minimal)$/.test(value) },
    { id: 'pi', name: 'Pi Coding Agent', accepts: value => /^(off|minimal|low|medium|high|xhigh|max)$/.test(value) },
    { id: 'mock', name: 'Mock（仅验证流程）', accepts: () => true }
];
function auditCapabilities(catalog) {
    return { maxReviewers: 8, maxConcurrency: 4, providers: PROVIDERS.map(provider => ({
        id: provider.id, name: provider.name,
        models: (catalog.series || []).filter(s => (catalog.engineSeriesRules?.[provider.id] || []).includes(s.id))
            .flatMap(s => s.models || []).map(model => ({ id: model.id, name: model.name || model.id,
                efforts: (model.efforts || []).filter(e => e.value && provider.accepts(String(e.value)))
                    .map(e => ({value: String(e.value), label: e.label || String(e.value)})) }))
    })) };
}
function normalizeReviewer(input, index, catalog) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_REVIEWER');
    const provider = auditCapabilities(catalog).providers.find(p => p.id === input.provider);
    if (!provider) throw new Error('UNSUPPORTED_AUDIT_PROVIDER');
    const text = value => { if (value != null && typeof value !== 'string') throw new Error('INVALID_REVIEWER_TEXT'); return (value || '').trim(); };
    const model = text(input.model), reasoningEffort = text(input.reasoningEffort);
    const known = provider.models.find(m => m.id === model);
    if (reasoningEffort && !known?.efforts.some(e => e.value === reasoningEffort)) throw new Error('UNSUPPORTED_MODEL_EFFORT');
    return { name: text(input.name) || `审核员 ${index + 1}`, provider: provider.id, model, reasoningEffort,
        prompt: text(input.prompt), scope: text(input.scope), checklist:normalizeChecklist(input.checklist) };
}
module.exports = { auditCapabilities, normalizeReviewer };
