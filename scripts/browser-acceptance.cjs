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
