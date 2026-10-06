'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('vm'),fs=require('fs'),path=require('path');
test('project ledger escapes evidence, filters recurrence and opens stored audit/run sources',async()=>{
    const elements=new Map(['workspaceRoot','issueSearch','issueState','issueSummary','projectIssues','btnRefreshIssues'].map(id=>[id,{value:'',textContent:'',innerHTML:''}]));
    elements.get('workspaceRoot').value='D:\\sample';const loaded=[],opened=[];
    const rows=[{id:'ISS-one',status:'REOPENED',severity:'HIGH',file:'app.js',problem:'<script>crash</script>',occurrenceCount:2,needsReview:true,history:[],decisions:[],occurrences:[{auditId:'audit1',at:'now',auditStatus:'COMPLETED',evidence:'<img onerror=bad>'}],repairRuns:[{runId:'run1',bugId:'BUG-1',status:'APPROVED'}]},
        {id:'ISS-two',status:'VERIFIED_CLOSED',severity:'LOW',file:'b.js',problem:'old issue',occurrenceCount:1,history:[],decisions:[],occurrences:[],repairRuns:[]}];
    const context={document:{getElementById:id=>elements.get(id),addEventListener:(_,fn)=>loaded.push(fn)},window:{auditApp:{openAudit:async id=>opened.push(id)}},
        escapeHtml:value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
        selectRun:async id=>opened.push(id),switchTab:tab=>opened.push(tab),fetch:async()=>({ok:true,json:async()=>rows})};
    vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/issues.js'),'utf8'),context);loaded[0]();await context.window.issueLedgerApp.refresh();
    assert.match(elements.get('issueSummary').textContent,/2 \/ 2/);assert(!elements.get('projectIssues').innerHTML.includes('<script>'));assert.match(elements.get('projectIssues').innerHTML,/&lt;img/);
    elements.get('issueState').value='REOPENED';elements.get('issueState').onchange();assert.match(elements.get('issueSummary').textContent,/1 \/ 2/);
    await elements.get('projectIssues').onclick({target:{dataset:{issueAudit:'audit1'}}});await elements.get('projectIssues').onclick({target:{dataset:{issueRun:'run1'}}});assert.deepEqual(opened,['audit1','run1','timeline']);
    rows[0].status='OPEN';rows[0].reopened=true;await context.window.issueLedgerApp.refresh();
    assert.match(elements.get('issueSummary').textContent,/1 \/ 2/);assert.match(elements.get('projectIssues').innerHTML,/待处理 · 再次出现/);
    context.fetch=async()=>{throw new Error('temporary disconnect');};await context.window.issueLedgerApp.refresh();assert.match(elements.get('issueSummary').textContent,/读取项目问题台账失败/);
    context.fetch=async()=>({ok:true,json:async()=>rows});await context.window.issueLedgerApp.refresh();assert.match(elements.get('issueSummary').textContent,/1 \/ 2/);
    elements.get('workspaceRoot').value='D:\\other';await elements.get('projectIssues').onclick({target:{dataset:{issueRun:'old-run'}}});assert.equal(opened.length,3);
});
