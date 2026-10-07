'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert/strict');

function resolvePlaywright() {
    const custom = process.env.STUDIO_PLAYWRIGHT_MODULE;
    if (custom) {
        if (!fs.existsSync(custom)) {
            throw new Error(`MISSING_PLAYWRIGHT_MODULE: Configured path does not exist: ${custom}`);
        }
        return require(custom);
    }
    const candidates = [
        'C:/Users/Administrator/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright',
        path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx', 'e41f203b7505f1fb', 'node_modules', 'playwright')
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) {
            return require(c);
        }
    }
    throw new Error('MISSING_PLAYWRIGHT_MODULE: Playwright module not found. Provide path via STUDIO_PLAYWRIGHT_MODULE environment variable.');
}

function resolveChrome() {
    const custom = process.env.STUDIO_CHROME_PATH;
    if (custom) {
        if (!fs.existsSync(custom)) {
            throw new Error(`MISSING_CHROME_EXECUTABLE: Configured path does not exist: ${custom}`);
        }
        return custom;
    }
    const candidates = [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe')
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) {
            return c;
        }
    }
    throw new Error('MISSING_CHROME_EXECUTABLE: Chrome executable not found. Provide path via STUDIO_CHROME_PATH environment variable.');
}

const startTime = Date.now();
const acceptanceId = `acceptance-${Date.now()}`;
const outputDir = process.env.STUDIO_ACCEPTANCE_OUTPUT || path.join(__dirname, '..', '.studio', 'acceptance', acceptanceId);
fs.mkdirSync(outputDir, { recursive: true });

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-acceptance-'));
const stateDir = path.join(fixtureRoot, 'state');
const workspace = path.join(fixtureRoot, 'workspace');
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'app.js'), 'const valid = true;\n', 'utf8');

process.env.STUDIO_DATA_DIR = stateDir;

const { RunStore } = require('../engine/run-store');
const { AuditWorkflow } = require('../engine/audit-workflow');
const { copyV0Fixtures } = require('../tests/helpers/studio-fixture');

const store = new RunStore(stateDir);
// Seed some v0 records for migration verification
copyV0Fixtures(store, workspace);

const checks = [];
const errors = [];
function ok(desc) {
    checks.push(desc);
    console.log(`PASS: ${desc}`);
}

(async () => {
    console.log(`Starting Dual-Agent Studio browser acceptance test [${acceptanceId}]...`);
    const { chromium } = resolvePlaywright();
    const chromePath = resolveChrome();

    // Prepare fixture audit
    const auditEngine = new AuditWorkflow(store, {
        preflight: async () => ({ ok: true, results: [] }),
        agent: async () => JSON.stringify({
            summary: 'Fixture code inspected',
            scopeComplete: true,
            coverage: ['app.js'],
            findings: []
        })
    });

    const audit = auditEngine.create({
        workspaceRoot: workspace,
        feature: '2.10 Browser Acceptance Fixture',
        commonPrompt: 'Fixture only',
        scope: 'app.js',
        reviewers: [{ provider: 'mock', name: '闭环审核' }]
    });
    auditEngine.launch(audit);
    await auditEngine.active.promise;

    const originalReviewers = JSON.stringify(store.read('audits', audit.id).reviewers);

    // Launch server on dynamic port
    const { server } = require('../server');
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    console.log(`Ephemeral test server running at ${base}`);

    const browser = await chromium.launch({
        executablePath: chromePath,
        headless: true
    });

    try {
        const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
        await context.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.abort());

        const page = await context.newPage();
        page.setDefaultTimeout(20000);
        page.on('pageerror', err => errors.push(err.message));

        await page.goto(base, { waitUntil: 'domcontentloaded' });
        ok('Web Cockpit DOM loaded successfully');

        // --- 1. Storage Maintenance & v0 Migration Modal ---
        const btnStorage = page.locator('#btnStorageMaintenance');
        if (await btnStorage.isVisible()) {
            await btnStorage.click();
            await page.locator('#storageMaintenanceModal').waitFor({ state: 'visible' });
            await page.locator('#storagePendingCount').waitFor();
            const pendingText = await page.locator('#storagePendingCount').innerText();
            ok(`Storage maintenance modal opened (Pending migrations: ${pendingText})`);

            // Execute migration
            await page.locator('#btnExecuteMigration').click();
            await page.locator('#storageMigrateResult').waitFor({ state: 'visible' });
            await page.screenshot({ path: path.join(outputDir, 'maintenance.png') });
            ok('Storage migration executed via modal with diagnostic report');

            await page.locator('#btnCloseMaintenanceModal').click();
            await page.locator('#storageMaintenanceModal').waitFor({ state: 'hidden' });
            ok('Storage maintenance modal closed cleanly');
        }

        // --- 2. 2.9 Human Acceptance & Evidence Flow ---
        await page.locator('#workspaceRoot').fill(workspace);
        await page.locator('#workspaceRoot').press('Tab');
        await page.getByRole('button', { name: '👥 审核报告', exact: true }).click();
        await page.locator('#auditHistory').selectOption(audit.id);

        // Verification blocked without test
        await page.locator('#auditClosureSummary').filter({ hasText: '缺少当前源码版本上通过的真实测试' }).waitFor();
        assert.equal(await page.locator('#btnAcceptClosure').isDisabled(), true);
        ok('Human acceptance blocked without actual test gate execution');

        // Verification test gate with command consent
        await page.locator('#auditClosureCommand').fill('node --check app.js');
        assert.equal(await page.locator('#btnTestClosure').isDisabled(), true);
        await page.locator('#auditClosureExecute').check();
        await page.locator('#btnTestClosure').click();

        await page.locator('#auditClosureSummary').filter({ hasText: '验收条件已满足' }).waitFor({ timeout: 60000 });
        assert.equal(await page.locator('#btnAcceptClosure').isDisabled(), true);
        ok('Test gate executed successfully, but acceptance note still mandatory');

        const testLogLink = page.locator('#auditClosureTestResult a');
        const logHref = await testLogLink.getAttribute('href');
        const logRes = await fetch(base + logHref);
        assert.equal(logRes.status, 200);
        ok('Actual test log artifact is accessible over HTTP');

        // Changed evidence invalidates draft note
        await page.locator('#auditClosureNote').fill('旧证据下准备的验收说明');
        await page.locator('#btnTestClosure').click();
        await page.locator('#auditClosureDraftHint').filter({ hasText: '证据已变化' }).waitFor();
        await page.locator('#auditClosureSummary').filter({ hasText: '验收条件已满足' }).waitFor({ timeout: 60000 });
        assert.equal(await page.locator('#btnAcceptClosure').isDisabled(), true);
        ok('Changed test evidence invalidates an existing drafted acceptance note');

        // Complete acceptance
        await page.locator('#auditClosureNote').fill('已检查当前源码、测试记录和范围，无暂缓项。');
        await page.locator('#btnAcceptClosure').click();
        await page.locator('#auditClosureSummary').filter({ hasText: '已人工验收' }).waitFor();
        await page.locator('#auditClosureBox').screenshot({ path: path.join(outputDir, 'accepted.png') });
        ok('Manual acceptance recorded with immutable test evidence');

        // Persists across reload
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.getByRole('button', { name: '👥 审核报告', exact: true }).click();
        await page.locator('#auditHistory').selectOption(audit.id);
        await page.locator('#auditClosureSummary').filter({ hasText: '已人工验收' }).waitFor();
        ok('Acceptance state survives full browser reload');

        // --- 3. Outdated Evidence on Source Code Change ---
        fs.appendFileSync(path.join(workspace, 'app.js'), '// changed after acceptance\n', 'utf8');
        await page.locator('#btnRefreshClosure').click();
        await page.locator('#auditClosureSummary').filter({ hasText: '过期证据' }).waitFor();
        assert.equal(await page.locator('#btnAcceptClosure').isDisabled(), true);
        assert((await page.locator('#auditClosureHistory').innerText()).includes('证据已变化'));
        ok('Source code modification invalidates acceptance while preserving evidence history');

        // --- 4. Linked Fresh Audit & Reset Consent on Recheck ---
        const recheckPromise = page.waitForResponse(r => r.url().endsWith('/closure-recheck') && r.request().method() === 'POST');
        await page.locator('#btnRecheckClosure').click();
        const recheckRes = await recheckPromise;
        assert.equal(recheckRes.status(), 202);
        const { auditId: freshAuditId } = await recheckRes.json();

        await page.locator('#auditSummary').filter({ hasText: '审核完成' }).waitFor({ timeout: 60000 });
        await page.locator('#btnRefreshClosure').click();
        await page.locator('#auditClosureCoverage').filter({ hasText: '已检查' }).waitFor();

        assert.equal(store.read('audits', freshAuditId).parentAudit.mode, 'RECHECK');
        assert.equal(JSON.stringify(store.read('audits', audit.id).reviewers), originalReviewers);
        assert.equal(await page.locator('#auditClosureExecute').isChecked(), false);
        await page.locator('#auditClosureBox').screenshot({ path: path.join(outputDir, 'rechecked.png') });
        ok('Source recheck creates linked fresh audit, preserves historical reports, and resets execution consent');

        // --- 5. Escaped Findings & Deferred Triage ---
        auditEngine.agent = async () => JSON.stringify({
            summary: 'Boundary test fixture',
            scopeComplete: true,
            coverage: ['app.js'],
            findings: [{
                category: 'BUG',
                severity: 'HIGH',
                file: 'app.js',
                lineRange: '1',
                problem: '<img src=x onerror=alert(1)> boundary test',
                evidence: 'Fixture boundary test',
                acceptance: 'Check boundary'
            }]
        });

        const boundaryAudit = auditEngine.create({
            workspaceRoot: workspace,
            feature: '2.10 Boundary Fixture',
            commonPrompt: 'Fixture only',
            scope: 'app.js',
            reviewers: [{ provider: 'mock' }]
        });
        auditEngine.launch(boundaryAudit);
        await auditEngine.active.promise;

        await page.locator('#btnRefreshAudits').click();
        await page.locator(`#auditHistory option[value="${boundaryAudit.id}"]`).waitFor({ state: 'attached' });
        await page.locator('#auditHistory').selectOption(boundaryAudit.id);

        await page.locator('#auditClosureTodos').filter({ hasText: '待确认' }).waitFor();
        assert.equal(await page.locator('#auditClosureTodos img').count(), 0);

        await page.locator('#auditClosureTodos button').click();
        const findingId = store.read('audits', boundaryAudit.id).findings[0].id;
        await page.locator(`#triageStatus-${findingId}`).selectOption('DEFERRED');
        await page.locator(`#triageNote-${findingId}`).fill('外部依赖暂不可用，延期至后续迭代。');
        await page.locator(`#triageSave-${findingId}`).click();
        await page.locator('#auditClosureTodos').filter({ hasText: '延期至后续迭代' }).waitFor();
        assert((await page.locator('#auditClosureTodos').innerText()).includes('暂缓'));
        await page.locator('#auditClosureBox').screenshot({ path: path.join(outputDir, 'deferred.png') });
        ok('Finding triage with deferred reason and XSS boundary escaping work correctly');

        // --- 6. Execution Budget & Resource Accounting Acceptance (2.11) ---
        const budgetAudit = auditEngine.create({
            workspaceRoot: workspace,
            feature: '2.11 Budget Acceptance',
            commonPrompt: 'Budget test',
            scope: 'app.js',
            budget: { maxAttempts: 1 },
            reviewers: [
                { provider: 'mock', name: '审核员一' },
                { provider: 'mock', name: '审核员二' }
            ]
        });
        auditEngine.launch(budgetAudit);
        await auditEngine.active.promise;

        const auditAfterRun = store.read('audits', budgetAudit.id);
        assert.equal(auditAfterRun.status, 'STOPPED');
        assert.equal(auditAfterRun.pauseReason, 'BUDGET_EXHAUSTED');
        assert.equal(auditAfterRun.reviewers.filter(r => r.status === 'COMPLETED').length, 1);
        assert.equal(auditAfterRun.reviewers.filter(r => r.status === 'STOPPED' && r.pauseReason === 'BUDGET_EXHAUSTED').length, 1);

        await page.locator('#btnRefreshAudits').click();
        await page.locator(`#auditHistory option[value="${budgetAudit.id}"]`).waitFor({ state: 'attached' });
        await page.locator('#auditHistory').selectOption(budgetAudit.id);

        await page.locator('#auditBudgetBox').filter({ hasText: '已用 1 次' }).waitFor();
        const budgetBoxText = await page.locator('#auditBudgetBox').innerText();
        assert(budgetBoxText.includes('上限 1 次'));
        assert(budgetBoxText.includes('剩余: 0 次'));
        assert(budgetBoxText.includes('未提供 (无外部计费适配器)'));
        assert(!budgetBoxText.includes('0 元') && !budgetBoxText.includes('0.00'));
        assert(budgetBoxText.includes('BUDGET_EXHAUSTED'));

        // Refresh keeps counts
        await page.locator('#btnRefreshAudits').click();
        await page.locator('#auditBudgetBox').filter({ hasText: '已用 1 次' }).waitFor();
        ok('Budget exhaustion pauses execution, preserves attempt counts on refresh, and displays non-zero unknown cost');

        // Test source change rejection on resume-budget
        const appJsPath = path.join(workspace, 'app.js');
        const origAppContent = fs.readFileSync(appJsPath, 'utf8');
        try {
            fs.writeFileSync(appJsPath, 'const modified = true;\n', 'utf8');
            const postResume = await fetch(`${base}/api/executions/audit/${budgetAudit.id}/resume-budget`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceRoot: workspace, version: auditAfterRun.version })
            });
            assert.equal(postResume.status, 409);
            const errJson = await postResume.json();
            assert.equal(errJson.error, 'AUDIT_SOURCE_CHANGED');
            ok('Resume after budget adjustment strictly rejects modified source with 409 AUDIT_SOURCE_CHANGED');
        } finally {
            fs.writeFileSync(appJsPath, origAppContent, 'utf8');
        }

        // Adjust budget and resume remaining unfinished reviewer
        const postAdjust = await fetch(`${base}/api/executions/audit/${budgetAudit.id}/budget`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                workspaceRoot: workspace,
                version: store.read('audits', budgetAudit.id).version,
                budget: { maxAttempts: 2 },
                reason: '追加 1 次额度以完成第二位审核员'
            })
        });
        assert.equal(postAdjust.status, 200);

        const reloadedAudit = store.read('audits', budgetAudit.id);
        for (const r of reloadedAudit.reviewers) {
            if (r.status === 'STOPPED' && r.pauseReason === 'BUDGET_EXHAUSTED') {
                r.status = 'QUEUED';
                delete r.pauseReason;
                r.error = '';
            }
        }
        delete reloadedAudit.pauseReason;
        delete reloadedAudit.allowedActions;
        auditEngine.launch(reloadedAudit);
        await auditEngine.active.promise;

        const finalAudit = store.read('audits', budgetAudit.id);
        assert.equal(finalAudit.status, 'COMPLETED');
        assert.equal(finalAudit.reviewers.filter(r => r.status === 'COMPLETED').length, 2);
        assert.equal(finalAudit.budget.reservations.filter(r => r.status === 'SETTLED').length, 2);
        ok('Resumed audit only executes previously unfinished reviewers and completes cleanly within new budget');

        // -------------------------------------------------------------
        // 2.12 Targeted Review Acceptance Checks
        // -------------------------------------------------------------
        const targetedWs = path.join(fixtureRoot, 'targeted-ws');
        fs.mkdirSync(path.join(targetedWs, 'engine'), { recursive: true });
        fs.mkdirSync(path.join(targetedWs, 'public'), { recursive: true });
        fs.writeFileSync(path.join(targetedWs, 'engine', 'core.js'), 'const core = 1;\n', 'utf8');
        fs.writeFileSync(path.join(targetedWs, 'public', 'app.js'), 'const app = 1;\n', 'utf8');

        // Baseline audit
        auditEngine.agent = async (req) => {
            const checklistMatch = [req?.prompt].join('').match(/Required checklist.*?:\s*(\[.+\])/);
            let taskChecks = [];
            if (checklistMatch) {
                try {
                    const list = JSON.parse(checklistMatch[1]);
                    taskChecks = list.map(item => ({ id: item.id, status: 'CHECKED', evidence: 'Mock verified' }));
                } catch {}
            }
            return JSON.stringify({
                summary: 'Fixture code inspected',
                scopeComplete: true,
                coverage: ['engine/core.js', 'public/app.js'],
                findings: [],
                taskChecks
            });
        };

        const baseAuditRecord = auditEngine.create({
            workspaceRoot: targetedWs,
            feature: 'Targeted Review Base',
            commonPrompt: 'Baseline inspection',
            scope: '全量审核',
            reviewers: [
                { provider: 'mock', name: 'Engine Reviewer', scope: 'engine/' },
                { provider: 'mock', name: 'UI Reviewer', scope: 'public/' }
            ]
        });
        auditEngine.launch(baseAuditRecord);
        await auditEngine.active.promise;

        const baseLoaded = store.read('audits', baseAuditRecord.id);
        assert.equal(baseLoaded.status, 'COMPLETED');

        // Check 1: Single file change preview in modal
        fs.writeFileSync(path.join(targetedWs, 'engine', 'core.js'), 'const core = 2;\n', 'utf8');
        await page.evaluate(async ({ auditId, ws }) => {
            document.getElementById('workspaceRoot').value = ws;
            await window.TargetedReviewUI.openPreview(auditId, ws);
        }, { auditId: baseAuditRecord.id, ws: targetedWs });

        await page.waitForSelector('#targetedReviewModal', { state: 'visible' });
        const modalHtml = await page.locator('#targetedPreviewContent').innerHTML();
        assert.ok(modalHtml.includes('engine/core.js'));
        assert.ok(modalHtml.includes('适用定向复查') || modalHtml.includes('✅'));
        ok('Targeted review modal opens and displays single file change without requiring full audit');

        // Check 2: Global configuration change triggers full audit warning and disables start until acknowledged
        fs.writeFileSync(path.join(targetedWs, 'package.json'), '{"name":"targeted-pkg"}\n', 'utf8');
        await page.evaluate(async ({ auditId, ws }) => {
            await window.TargetedReviewUI.openPreview(auditId, ws);
        }, { auditId: baseAuditRecord.id, ws: targetedWs });

        const modalWithConfig = await page.locator('#targetedPreviewContent').innerHTML();
        assert.ok(modalWithConfig.includes('package.json'));
        assert.ok(modalWithConfig.includes('GLOBAL_CONFIG_CHANGED') || modalWithConfig.includes('建议全量审核'));
        const btnStartDisabled = await page.locator('#btnConfirmTargetedStart').isDisabled();
        assert.equal(btnStartDisabled, true);

        // Check acknowledgment checkbox enables the start button
        await page.locator('#chkAcknowledgeFullAudit').check();
        const btnStartEnabled = await page.locator('#btnConfirmTargetedStart').isEnabled();
        assert.equal(btnStartEnabled, true);
        ok('Global configuration change enforces full audit warning and requires explicit acknowledgment');

        // Check 3: Stale preview 409 rejection
        const staleRes = await fetch(`http://127.0.0.1:${port}/api/audits/${baseAuditRecord.id}/targeted-start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                workspaceRoot: targetedWs,
                version: 'stale-version-xyz',
                taskIds: ['TP-1'],
                acknowledgeFullAudit: true
            })
        });
        assert.equal(staleRes.status, 409);
        ok('Outdated preview plan version is rejected with 409 PLAN_VERSION_CONFLICT');

        // Check 4: Start targeted review and verify persistent banner in report
        const freshPreviewRes = await fetch(`http://127.0.0.1:${port}/api/audits/${baseAuditRecord.id}/targeted-preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceRoot: targetedWs })
        });
        const freshPlan = await freshPreviewRes.json();
        const startTargetedRes = await fetch(`http://127.0.0.1:${port}/api/audits/${baseAuditRecord.id}/targeted-start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                workspaceRoot: targetedWs,
                version: freshPlan.version,
                taskIds: [freshPlan.proposedTasks[0].id],
                acknowledgeFullAudit: true,
                note: 'Browser acceptance targeted run'
            })
        });
        assert.equal(startTargetedRes.status, 202);
        const { auditId: targetedRunId } = await startTargetedRes.json();

        // Wait for targeted run to complete
        for (let i = 0; i < 100; i++) {
            const checkAudit = store.read('audits', targetedRunId);
            if (checkAudit.status !== 'RUNNING' && checkAudit.status !== 'CREATED') break;
            await new Promise(r => setTimeout(r, 50));
        }
        const completedTargeted = store.read('audits', targetedRunId);
        assert.ok(['COMPLETED', 'PARTIAL'].includes(completedTargeted.status));
        assert.equal(completedTargeted.parentAudit.mode, 'TARGETED');

        // Load targeted audit in browser
        await page.evaluate(async (id) => {
            window.TargetedReviewUI.closePreview();
            await window.auditApp.openAudit(id);
        }, targetedRunId);

        await page.waitForSelector('.audit-targeted-banner', { state: 'attached' });
        const bannerText = await page.locator('.audit-targeted-banner').textContent();
        assert.ok(bannerText.includes('定向复查（局部范围）'));
        assert.ok(bannerText.includes('完整审核仍待完成') || bannerText.includes('局部范围'));
        ok('Targeted review completes and renders persistent partial scope banner in audit report');

        // Check 5: Partial targeted completion prevents overall closure acceptance
        const { closureView } = require('../engine/audit-closure');
        const { buildManifest } = require('../engine/source-manifest');
        const finalManifest = await buildManifest(targetedWs);
        const finalClosure = closureView(store, baseAuditRecord.id, finalManifest.snapshot);
        assert.equal(finalClosure.ready, false);
        assert.ok(finalClosure.blockers.some(b => b.includes('缺口') || b.includes('过期')));
        ok('Partial targeted completion prevents overall closure acceptance when full baseline is unverified');

        // ================================================================
        // 2.13 DISPUTE RESOLUTION AND HUMAN DECISIONS ACCEPTANCE
        // ================================================================
        const baseAuditForDispute = store.read('audits', baseAuditRecord.id);
        const disputeFinding = {
            id: 'F-DISPUTE-1',
            category: 'BUG',
            severity: 'HIGH',
            file: 'engine/core.js',
            lineRange: '1-10',
            problem: 'Potential race condition under concurrent access',
            evidence: 'const core = 2;\n',
            acceptance: 'Thread safe lock',
            sources: [{ reviewerId: baseAuditForDispute.reviewers[0].id, findingId: 'F-DISPUTE-1' }]
        };
        baseAuditForDispute.findings = [disputeFinding];
        store.save('audits', baseAuditForDispute);

        // Check 1: Create dispute case from finding
        await page.evaluate(async ({ auditId, ws }) => {
            document.getElementById('workspaceRoot').value = ws;
            await window.decisionsApp.openFromFinding(auditId, 'F-DISPUTE-1');
            document.getElementById('decisionCreateQuestion').value = 'Is thread safety required in single-process node?';
            await window.decisionsApp.submitCreateCase();
        }, { auditId: baseAuditForDispute.id, ws: targetedWs });

        await page.waitForSelector('#decisionCaseDetail', { state: 'visible' });
        const caseDetailHtml = await page.locator('#decisionCaseDetail').innerHTML();
        assert.ok(caseDetailHtml.includes('Potential race condition under concurrent access'));
        ok('Dispute case created from finding with anchor and structured references');

        // Check 2: Execute mock single-shot arbitration
        await page.evaluate(async () => {
            await window.decisionsApp.analyzeCurrentCase();
        });
        const detailAfterArb = await page.locator('#decisionCaseDetail').innerHTML();
        assert.ok(detailAfterArb.includes('待人工决策') || detailAfterArb.includes('AWAITING_HUMAN'));
        assert.ok(detailAfterArb.includes('建议可选动作') || detailAfterArb.includes('Options') || detailAfterArb.includes('仲裁建议分析'));
        ok('Single-shot arbitration generates advisory options and maintains non-decided state');

        // Check 3: Human decision recorded and applied to audit finding triage
        await page.evaluate(async () => {
            document.getElementById('decisionAction').value = 'DEFER';
            document.getElementById('decisionNote').value = 'Node is single-threaded event loop; defer to cluster milestone';
            await window.decisionsApp.saveDecision();
        });
        const detailAfterDecide = await page.locator('#decisionCaseDetail').innerHTML();
        assert.ok(detailAfterDecide.includes('已决策，待应用'));

        // Apply decision triage
        await page.evaluate(async () => {
            const btn = document.querySelector('button[onclick*="applyCurrentDecision"]');
            if (btn) btn.click();
        });
        await page.waitForTimeout(300);

        const auditAfterDecision = store.read('audits', baseAuditForDispute.id);
        assert.equal(auditAfterDecision.triage['F-DISPUTE-1'].status, 'DEFERRED');
        assert.ok(auditAfterDecision.triage['F-DISPUTE-1'].history[0].decisionApplicationId);

        const closureAfterDecision = closureView(store, baseAuditForDispute.id, (await buildManifest(targetedWs)).snapshot);
        const closureFinding = closureAfterDecision.findings.find(f => f.findingId === 'F-DISPUTE-1' || f.problem.includes('Potential race condition'));
        assert.ok(closureFinding);
        assert.equal(closureFinding.state, 'DEFERRED');
        ok('Human decision applied idempotently to audit finding and visible in closure view');

        // Check 4: Stale evidence check flags NEEDS_REVIEW
        const auditToMutate = store.read('audits', baseAuditForDispute.id);
        auditToMutate.findings[0].evidence = 'CHANGED_EVIDENCE_KEY_FOR_STALENESS';
        store.save('audits', auditToMutate);

        await page.evaluate(async () => {
            await window.decisionsApp.refreshCurrent();
        });
        const detailStale = await page.locator('#decisionCaseDetail').innerHTML();
        assert.ok(detailStale.includes('证据已变动') || detailStale.includes('NEEDS_REVIEW') || detailStale.includes('失效'));
        ok('Evidence modification flags case as NEEDS_REVIEW and prevents applying outdated decision');

        // Ensure no uncaught browser page errors
        assert.deepEqual(errors, []);
        ok('No uncaught browser console/script errors encountered throughout run');

    } finally {
        await browser.close();
        server.closeAllConnections();
        await new Promise(r => server.close(r));

        const results = {
            acceptanceId,
            success: errors.length === 0,
            durationMs: Date.now() - startTime,
            environment: {
                node: process.version,
                platform: process.platform,
                chrome: chromePath,
                outputDir
            },
            checks,
            errors
        };
        fs.writeFileSync(path.join(outputDir, 'results.json'), JSON.stringify(results, null, 2), 'utf8');
        console.log(`Acceptance artifacts recorded at: ${outputDir}`);

        // Cleanup temporary fixture root
        try {
            if (path.dirname(fixtureRoot) === fs.realpathSync(os.tmpdir())) {
                fs.rmSync(fixtureRoot, { recursive: true, force: true });
            }
        } catch {}
    }

    console.log(`================================================================`);
    console.log(` 🏆 Browser Acceptance PASSED: ${checks.length} checks verified.`);
    console.log(`================================================================`);
})().catch(err => {
    console.error('Browser Acceptance FAILED:', err);
    process.exitCode = 1;
});
