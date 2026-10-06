'use strict';
// These checks validate provenance, not whether a model's interpretation is correct.
function required(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 16000) throw new Error('INVALID_REVIEW_EVIDENCE');
    return value.trim();
}
function relativeFile(value) {
    const file = required(value).replace(/\\/g, '/');
    if (file.startsWith('/') || file.includes(':') || file.split('/').some(p => p === '..' || !p)) throw new Error('INVALID_EVIDENCE_PATH');
    return file;
}
function evidenceRefs(refs, gate, snapshot) {
    if (refs === undefined) return [];
    if (!Array.isArray(refs) || refs.length > 30) throw new Error('INVALID_REVIEW_EVIDENCE');
    return refs.map(ref => {
        if (!ref || !['SOURCE', 'TEST'].includes(ref.kind)) throw new Error('INVALID_REVIEW_EVIDENCE');
        if (ref.kind === 'SOURCE') {
            if (!Number.isInteger(ref.startLine) || ref.startLine < 1 || !Number.isInteger(ref.endLine) || ref.endLine < ref.startLine) throw new Error('INVALID_EVIDENCE_LINES');
            return {kind:'SOURCE', file:relativeFile(ref.file), startLine:ref.startLine, endLine:ref.endLine,
                explanation:required(ref.explanation), provenance:'AGENT_SOURCE_CLAIM', snapshot};
        }
        const quote = required(ref.quote);
        if (!gate || !Number.isInteger(gate.exitCode) || gate.sourceChanged || gate.snapshot !== snapshot || !gate.artifact || ref.artifact !== gate.artifact || !gate.output?.includes(quote)) throw new Error('UNVERIFIED_TEST_EVIDENCE');
        return {kind:'TEST', artifact:gate.artifact, quote, explanation:required(ref.explanation),
            provenance:'STUDIO_EXECUTION', snapshot, exitCode:gate.exitCode};
    });
}
function coverageDetails(value, scopeComplete) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 200) throw new Error('INVALID_COVERAGE_DETAILS');
    const seen = new Set();
    return value.map(item => {
        if (!item || !['CHECKED','UNCHECKED','DISPUTED'].includes(item.status)) throw new Error('INVALID_COVERAGE_DETAILS');
        const target = required(item.target);
        if (seen.has(target)) throw new Error('DUPLICATE_COVERAGE_TARGET');
        seen.add(target);
        if (scopeComplete && item.status !== 'CHECKED') throw new Error('CONTRADICTORY_COVERAGE');
        return {target, status:item.status, checks:required(item.checks), limitations:required(item.limitations)};
    });
}
const evidenceInstructions = `Include evidenceRefs for each finding/verification/acceptance check when evidence is available: SOURCE {kind:"SOURCE",file:"relative/path",startLine:1,endLine:2,explanation:"reason"} is a source claim, not executed proof. TEST {kind:"TEST",artifact:"exact latest test artifact",quote:"exact non-empty substring of recorded output",explanation:"why this output supports this specific check"} requires Studio-recorded execution on this snapshot. Never invent TEST references; a command passing alone does not prove a criterion. Include coverageDetails [{target:"file/module or requested check",status:"CHECKED|UNCHECKED|DISPUTED",checks:"actual checks or missing checks",limitations:"limitations, or none identified"}]. Include known gaps and disputes; scopeComplete must be false when any item is UNCHECKED or DISPUTED. This is self-reported coverage, not a percentage of the entire project.`;
module.exports = {evidenceRefs, coverageDetails, evidenceInstructions};
