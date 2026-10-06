'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {normalizeChecklist,applyChecklist,auditGaps,supplementVersion}=require('../engine/audit-assignment');
test('checklists are bounded, reject duplicates, and missing required answers remain unchecked',()=>{
 assert.deepEqual(normalizeChecklist(undefined),[]);
 assert.throws(()=>normalizeChecklist(['a',' a ']),/CHECKLIST/);
 assert.throws(()=>normalizeChecklist(Array(21).fill('x')),/CHECKLIST/);
 const report={scopeComplete:true};applyChecklist(report,['null input']);
 assert.equal(report.scopeComplete,false);assert.equal(report.taskChecks[0].status,'UNCHECKED');
 assert.throws(()=>applyChecklist({scopeComplete:true,taskChecks:[{id:'C-1',status:'DISPUTED',evidence:'unclear'}]},['null input']),/CONTRADICTORY/);
 assert.throws(()=>applyChecklist({scopeComplete:false,taskChecks:[{id:'C-99',status:'CHECKED',evidence:'fake'}]},['null input']),/TASK/);
});
test('gaps retain reviewer ownership and preserve completed required checks',()=>{
 const record={snapshot:'v1',status:'PARTIAL',reviewers:[{id:'r1',name:'A',status:'COMPLETED',checklist:['done','missing'],report:{scopeComplete:false,taskChecks:[{id:'C-1',status:'CHECKED',evidence:'source'}]}},{id:'r2',name:'B',status:'FAILED',checklist:[]}]};
 assert.deepEqual(auditGaps(record).map(g=>[g.reviewerId,g.taskId]),[['r1','C-2'],['r2','SCOPE']]);
 const version=supplementVersion(record);record.reviewers[0].report.scopeComplete=true;assert.notEqual(supplementVersion(record),version);
});
