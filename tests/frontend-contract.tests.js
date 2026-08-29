const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('🧪 Running Dual-Agent Studio Frontend Contract Tests...');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const jsPath = path.join(__dirname, '..', 'public', 'app.js');

assert(fs.existsSync(htmlPath), 'index.html must exist in public/');
assert(fs.existsSync(jsPath), 'app.js must exist in public/');

const htmlContent = fs.readFileSync(htmlPath, 'utf-8');
const jsContent = fs.readFileSync(jsPath, 'utf-8');

// 1. Validate HTML Element IDs
const requiredIds = [
    'toastContainer',
    'workspaceRoot',
    'featureName',
    'maxRounds',
    'maxSelfHealAttempts',
    'autoCommit',
    'verifyCommand',
    'taskPrompt',
    'vaguePrompt',
    'maxDiscussionRounds',
    'btnStartDiscuss',
    'devProvider',
    'devSeries',
    'devReasoningEffort',
    'devModel',
    'devModelCustom',
    'devSessionId',
    'btnResetDevSession',
    'reviewProvider',
    'reviewSeries',
    'reviewReasoningEffort',
    'reviewModel',
    'reviewModelCustom',
    'reviewSessionId',
    'btnResetReviewSession',
    'btnStart',
    'btnStop',
    'statusBadge',
    'statusText',
    'roundBadge',
    'currentRoundText',
    'maxRoundText',
    'timelineContainer',
    'emptyTimeline',
    'roundsList',
    'discussionMessages',
    'discussionStatusBadge',
    'humanDecisionGate',
    'finalPlanEditor',
    'diffViewer',
    'diffCode',
    'diffStats',
    'btnCopyDiff',
    'logsConsole',
    'autoScroll',
    'folderModal',
    'btnNavUp',
    'folderCurrentPath',
    'quickDrives',
    'folderList',
    'modelModal',
    'modelsJsonEditor'
];

for (const id of requiredIds) {
    const hasId = htmlContent.includes(`id="${id}"`) || htmlContent.includes(`id='${id}'`);
    assert(hasId, `index.html must contain DOM element with id="${id}"`);
}
console.log(`✅ DOM Structure Verified (${requiredIds.length} mandatory element IDs confirmed).`);

// 2. Validate JavaScript Function Contracts and Global Exports
const requiredFunctions = [
    'showToast',
    'openFolderPickerModal',
    'closeFolderPickerModal',
    'navigateUpFolder',
    'confirmSelectedFolder',
    'openFolderPicker',
    'openFolderModal',
    'closeFolderModal',
    'navigateParentFolder',
    'confirmFolderSelection',
    'startDiscussion',
    'approvePlanAndStart',
    'startLoop',
    'stopLoop',
    'fetchDiff',
    'copyDiffToClipboard',
    'autoDetectWorkspace',
    'fetchSessions',
    'resetWorkspaceSessions',
    'loadUserPreferences',
    'saveUserPreferences'
];

for (const fn of requiredFunctions) {
    assert(jsContent.includes(`function ${fn}`) || jsContent.includes(`${fn} =`), `app.js must define function '${fn}'`);
    if (!['autoDetectWorkspace', 'loadUserPreferences', 'saveUserPreferences'].includes(fn)) {
        assert(jsContent.includes(`window.${fn} = ${fn}`), `app.js must mount '${fn}' on window object`);
    }
}
console.log(`✅ Function Contracts Verified (${requiredFunctions.length} client functions & window bindings confirmed).`);

// 3. Ensure no native alert() calls remain in app.js
const alertMatch = jsContent.match(/(?<!showToast\([^)]*)\balert\s*\(/g);
assert(!alertMatch, `app.js should not contain raw alert() calls; found ${alertMatch ? alertMatch.length : 0} occurrences. Use showToast() instead.`);
console.log('✅ Native alert() Elimination Verified (100% replaced by Toast system).');

console.log('🎉 All Frontend Contract Tests Passed Successfully!\n');
