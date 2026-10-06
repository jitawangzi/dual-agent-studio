'use strict';
const {evidenceRefs}=require('./review-evidence');
function trackProgress(run,outcome,snapshot){
    const pending=run.bugs.filter(b=>b.status!=='VERIFIED_CLOSED').map(b=>b.id).sort();
    const previous=run.progressCheckpoint;
    const resolved=previous?previous.pending.filter(id=>run.bugs.some(b=>b.id===id&&b.status==='VERIFIED_CLOSED')):[];
    const stalled=previous&&!outcome.clean&&!resolved.length;
    const count=stalled?(previous.stalledRounds||0)+1:0;
    const checkpoint={round:run.round,pending,resolved,snapshot,testStatus:run.testGate?.status,stalledRounds:count,summary:run.lastReview.summary};
    run.progressCheckpoint=checkpoint;run.progressHistory||=[];run.progressHistory.push(checkpoint);
    if(count>=(run.config.maxNoProgressRounds||3)){
        run.attention={reason:'NO_PROGRESS',summary:`连续 ${count} 轮未关闭已有问题，也未通过完整验收，请调整方案或补充依据后继续。`,
            pendingIds:pending,rounds:run.progressHistory.slice(-(count+1))};
        return true;
    }
    return false;
}
function parseTargetedReview(report,bugs,gate,snapshot){
    if(!report||typeof report.summary!=='string'||!report.summary.trim()||!Array.isArray(report.verifications)||report.verifications.length!==bugs.length)throw new Error('INCOMPLETE_TARGETED_REVIEW');
    const seen=new Set();
    for(const check of report.verifications){
        if(!bugs.some(b=>b.id===check.id)||seen.has(check.id)||!['RESOLVED','UNRESOLVED','DISPUTED'].includes(check.result)||typeof check.evidence!=='string'||!check.evidence.trim())throw new Error('INVALID_TARGETED_REVIEW');
        seen.add(check.id);
    }
    return {summary:report.summary,verifications:report.verifications.map(({id,result,evidence,evidenceRefs:refs})=>({id,result,evidence,evidenceRefs:evidenceRefs(refs,gate,snapshot)}))};
}
module.exports={trackProgress,parseTargetedReview};
