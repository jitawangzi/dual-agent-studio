'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function setupDom() {
    const elements = new Map();
    class MockElement {
        constructor(tag = 'div') {
            this.tag = tag;
            this.value = '';
            this.textContent = '';
            this.checked = false;
            this.disabled = false;
            this.style = {};
            this.children = [];
            this.attributes = new Map();
        }
        set innerHTML(html) {
            this.html = html;
            for (const match of html.matchAll(/<([a-z0-9-]+)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
                const el = new MockElement(match[1]);
                el.id = match[2];
                elements.set(el.id, el);
            }
        }
        get innerHTML() {
            return this.html || '';
        }
        querySelector(selector) {
            if (selector.startsWith('#')) return elements.get(selector.slice(1)) || null;
            return null;
        }
        querySelectorAll(selector) {
            if (selector === '.chk-targeted-task:checked') {
                return Array.from(elements.values()).filter(el => el.classList?.has('chk-targeted-task') && el.checked);
            }
            if (selector === '.chk-targeted-task') {
                return Array.from(elements.values()).filter(el => el.classList?.has('chk-targeted-task'));
            }
            return [];
        }
    }

    const modal = new MockElement('div'); modal.id = 'targetedReviewModal'; elements.set(modal.id, modal);
    const content = new MockElement('div'); content.id = 'targetedPreviewContent'; elements.set(content.id, content);
    const btnConfirm = new MockElement('button'); btnConfirm.id = 'btnConfirmTargetedStart'; btnConfirm.disabled = true; elements.set(btnConfirm.id, btnConfirm);

    const context = {
        document: {
            getElementById: id => elements.get(id) || null,
            querySelectorAll: sel => modal.querySelectorAll(sel),
            createElement: tag => new MockElement(tag)
        },
        window: {},
        fetch: null,
        showToast: () => {},
        console
    };

    vm.createContext(context);
    const code = fs.readFileSync(path.join(__dirname, '../public/targeted-review.js'), 'utf8');
    vm.runInContext(code, context);

    return { context, elements };
}

test('TargetedReviewUI: renderTargetedBannerHtml renders persistent banner with full-audit alert', () => {
    const { context } = setupDom();
    const UI = context.window.TargetedReviewUI;

    const normalRecord = {
        id: 'child-1',
        parentAudit: { id: 'base-1', mode: 'TARGETED' },
        targetedPlan: {
            baseAuditId: 'base-1',
            selectedTaskIds: ['TP-1'],
            changedFiles: ['engine/core.js'],
            requiresFullAudit: false,
            reasons: [],
            note: 'Local review'
        }
    };

    const normalHtml = UI.renderTargetedBannerHtml(normalRecord);
    assert.match(normalHtml, /定向复查（局部范围）/);
    assert.match(normalHtml, /base-1/);
    assert.match(normalHtml, /局部范围审查完成/);
    assert.match(normalHtml, /Local review/);

    const fullAuditRecord = {
        id: 'child-2',
        parentAudit: { id: 'base-2', mode: 'TARGETED' },
        targetedPlan: {
            baseAuditId: 'base-2',
            selectedTaskIds: ['TP-1'],
            changedFiles: ['package.json'],
            uncoveredScopes: ['unknown.js'],
            requiresFullAudit: true,
            reasons: ['GLOBAL_CONFIG_CHANGED: package.json'],
            note: ''
        }
    };

    const fullAuditHtml = UI.renderTargetedBannerHtml(fullAuditRecord);
    assert.match(fullAuditHtml, /存在全局改动，完整审核仍待完成/);
    assert.match(fullAuditHtml, /GLOBAL_CONFIG_CHANGED/);
    assert.match(fullAuditHtml, /unknown\.js/);
});

test('TargetedReviewUI: openPreview fetches preview and toggles start button on acknowledgment', async () => {
    const { context, elements } = setupDom();
    const UI = context.window.TargetedReviewUI;

    const mockPlan = {
        version: 'plan-v1',
        baseAuditId: 'base-audit-uuid',
        changedFiles: ['db/migrations/001.sql'],
        uncoveredScopes: [],
        requiresFullAudit: true,
        reasons: ['MIGRATION_FILE_CHANGED'],
        proposedTasks: [
            {
                id: 'TP-1',
                reviewerName: 'DB Reviewer',
                batch: 1,
                totalBatches: 1,
                scope: 'db/',
                reason: 'Migration review',
                checklist: ['Check migration rollback safety']
            }
        ],
        estimatedAttempts: {
            minimumAttempts: 1,
            maximumAttempts: 2,
            assumptions: ['Static assumption']
        }
    };

    context.fetch = async (url, init) => {
        if (url.includes('targeted-preview')) {
            return {
                ok: true,
                json: async () => mockPlan
            };
        }
        return { ok: false, json: async () => ({}) };
    };

    await UI.openPreview('base-audit-uuid', 'D:\\workspace');

    const content = elements.get('targetedPreviewContent');
    assert.match(content.innerHTML, /db\/migrations\/001\.sql/);
    assert.match(content.innerHTML, /MIGRATION_FILE_CHANGED/);
    assert.match(content.innerHTML, /TP-1/);
    assert.match(content.innerHTML, /chkAcknowledgeFullAudit/);

    const btnStart = elements.get('btnConfirmTargetedStart');
    // Initially disabled because requiresFullAudit is true and chkAcknowledgeFullAudit is unchecked
    assert.equal(btnStart.disabled, true);

    // When user checks chkAcknowledgeFullAudit
    const chkAck = elements.get('chkAcknowledgeFullAudit');
    assert.ok(chkAck);

    // Mock querySelectorAll for task checkboxes
    const taskCheckbox = { classList: new Set(['chk-targeted-task']), checked: true, value: 'TP-1' };
    context.document.querySelectorAll = sel => {
        if (sel.includes(':checked')) return [taskCheckbox];
        return [taskCheckbox];
    };

    chkAck.checked = true;
    UI.updateButtonState();
    assert.equal(btnStart.disabled, false);

    chkAck.checked = false;
    UI.updateButtonState();
    assert.equal(btnStart.disabled, true);
});
