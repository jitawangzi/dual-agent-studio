'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),vm=require('vm'),path=require('path');
const {evidenceRefs,coverageDetails}=require('../engine/review-evidence');
const {parseReport}=require('../engine/audit-workflow');
const {parseTargetedReview}=require('../engine/review-progress');
const gate={artifact:'tests-1.txt',exitCode:0,snapshot:'v1',output:'null input: PASS\n2 tests passed',sourceChanged:false};
const reference={kind:'TEST',artifact:'tests-1.txt',quote:'null input: PASS',explanation:'covers the trigger'};
test('execution references require exact artifact, snapshot and output, not a claimed PASS',()=>{
    assert.equal(evidenceRefs([reference],gate,'v1')[0].provenance,'STUDIO_EXECUTION');
    for(const [ref,g,s] of [[reference,null,'v1'],[reference,gate,'v2'],[{...reference,artifact:'old.txt'},gate,'v1'],[{...reference,quote:'invented'},gate,'v1'],[reference,{...gate,sourceChanged:true},'v1'],[reference,{...gate,exitCode:null},'v1']])
        assert.throws(()=>evidenceRefs([ref],g,s),/UNVERIFIED_TEST_EVIDENCE/);
    assert.equal(evidenceRefs([reference],{...gate,exitCode:1},'v1')[0].exitCode,1);
});
test('source references reject traversal and invalid lines and remain explicitly unverified claims',()=>{
    const source={kind:'SOURCE',file:'src/app.js',startLine:2,endLine:4,explanation:'static condition'};
    assert.equal(evidenceRefs([source],null,'v1')[0].provenance,'AGENT_SOURCE_CLAIM');
    for(const file of ['../secret','C:/secret','/etc/passwd','src/../../x','src\\..\\x'])assert.throws(()=>evidenceRefs([{...source,file}],null,'v1'),/PATH/);
    assert.throws(()=>evidenceRefs([{...source,endLine:1}],null,'v1'),/LINES/);
    assert.deepEqual(evidenceRefs(undefined),[]);
});
test('coverage gaps and disputes cannot coexist with a complete-scope claim; legacy stays unknown',()=>{
    for(const status of ['UNCHECKED','DISPUTED']){
        const rows=[{target:'auth',status,checks:'requires review',limitations:'no test environment'}];
        assert.equal(coverageDetails(rows,false)[0].status,status);
        assert.throws(()=>coverageDetails(rows,true),/CONTRADICTORY/);
    }
    const row={target:'auth',status:'CHECKED',checks:'source read',limitations:'no execution'};
    assert.throws(()=>coverageDetails([row,row],true),/DUPLICATE/);
    assert.deepEqual(coverageDetails(undefined,true),[]);
});
test('parallel audits cannot invent Studio execution; targeted review validates and preserves references',()=>{
    const finding={category:'BUG',severity:'HIGH',file:'app.js',problem:'null crash',evidence:'line 2',acceptance:'no crash',evidenceRefs:[reference]};
    assert.throws(()=>parseReport(JSON.stringify({summary:'review',scopeComplete:true,coverage:['app.js'],findings:[finding]}),'v1'),/UNVERIFIED/);
    const report={summary:'review',verifications:[{id:'BUG-1',result:'RESOLVED',evidence:'test and source',evidenceRefs:[reference]}]};
    assert.equal(parseTargetedReview(report,[{id:'BUG-1'}],gate,'v1').verifications[0].evidenceRefs[0].artifact,gate.artifact);
    assert.throws(()=>parseTargetedReview(report,[{id:'BUG-1'}],gate,'v2'),/UNVERIFIED/);
});
test('evidence and coverage HTML escape model content and distinguish missing reports',()=>{
    const context={};vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/review-evidence.js'),'utf8'),context);
    const ui=context.reviewEvidenceUI;
    const html=ui.refs([{kind:'SOURCE',file:'<img onerror=x>',explanation:'<script>bad</script>',snapshot:'v1',startLine:1,endLine:2}], 'runs','r1')+ui.coverage({coverageDetails:[{target:'<svg>',status:'UNCHECKED',checks:'<script>',limitations:'unknown'}]});
    assert(!html.includes('<script>'));assert(!html.includes('<img'));assert.match(html,/&lt;svg&gt;/);assert.match(html,/未检查/);
    assert.match(ui.refs([],'runs','r1'),/未提供结构化证据/);assert.match(ui.coverage({coverage:['legacy']}),/原始范围声明：legacy/);
    assert.match(ui.refs(evidenceRefs([reference],gate,'v1'),'runs','r1'),/artifacts\?name=tests-1.txt/);
});
