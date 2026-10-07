/**
 * @file decisions-ui.tests.js
 * @author shuyongqiang
 * @description Unit tests for DecisionsUI frontend controller.
 */
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
            this.eventListeners = new Map();
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
        addEventListener(event, fn) {
            this.eventListeners.set(event, fn);
        }
    }

    const reg = id => {
        const el = new MockElement();
        el.id = id;
        elements.set(id, el);
        return el;
    };

    reg('workspaceRoot').value = 'D:\\test-workspace';
    reg('decisionCaseList');
    reg('decisionCaseDetail');
    reg('createDecisionModal');
    reg('decisionCreateTitle');
    reg('decisionCreateQuestion');
    reg('decisionCreateAnchorInfo');
    reg('decisionCreateAnchorSummary');
    reg('decisionCreateReferencesList');
    reg('btnNewDecisionCase');
    reg('btnSubmitCreateCase');
    reg('btnCancelCreateCase');

    const context = {
        document: {
            getElementById: id => elements.get(id) || null,
            addEventListener: () => {},
            createElement: tag => new MockElement(tag)
        },
        window: {},
        escapeHtml: str => String(str).replace(/[&<>"']/g, m => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[m])),
        fetch: null,
        showToast: () => {},
        switchTab: () => {},
        console
    };

    vm.createContext(context);
    const code = fs.readFileSync(path.join(__dirname, '../public/decisions.js'), 'utf8');
    vm.runInContext(code, context);

    return { context, elements };
}

test('decisionsApp: openCreateModal populates form fields and shows modal', () => {
    const { context, elements } = setupDom();
    const app = context.window.decisionsApp;

    app.openCreateModal({
        title: 'Input empty string dispute',
        question: 'Should empty strings fail or fallback?',
        anchor: {
            auditId: 'audit-12345678-0000-0000-0000-000000000000',
            findingId: 'F-1'
        },
        references: [
            { kind: 'AUDIT_FINDING', recordId: 'audit-12345678-0000-0000-0000-000000000000', itemId: 'F-1' }
        ]
    });

    assert.equal(elements.get('decisionCreateTitle').value, 'Input empty string dispute');
    assert.equal(elements.get('decisionCreateQuestion').value, 'Should empty strings fail or fallback?');
    assert.equal(elements.get('createDecisionModal').style.display, 'flex');
    assert.equal(elements.get('decisionCreateAnchorInfo').style.display, 'block');
    assert.match(elements.get('decisionCreateAnchorSummary').textContent, /F-1/);
});

test('decisionsApp: selectCase renders detail with positions, options and human decision box', async () => {
    const { context, elements } = setupDom();
    const app = context.window.decisionsApp;

    const mockCase = {
        id: 'case-11111111-2222-3333-4444-555555555555',
        title: 'Empty string dispute',
        question: 'Should empty string be permitted?',
        status: 'AWAITING_HUMAN',
        stale: false,
        version: 'ver-hash-1',
        anchor: {
            findingId: 'F-1',
            finding: { category: 'BUG', severity: 'HIGH', problem: 'Null pointer', file: 'app.js', lineRange: '1-5' }
        },
        references: [
            { kind: 'AUDIT_FINDING', recordId: 'audit-1', itemId: 'F-1', snapshot: { problem: 'Null pointer' }, stale: false }
        ],
        analysis: {
            summary: 'Disagreement between dev and audit',
            positions: [
                { referenceIndex: 0, claim: 'Null pointer hazard', support: 'app.js:2', limitations: 'Depends on caller' }
            ],
            options: [
                { id: 'O-1', action: 'VERIFY_MORE', reason: 'Need reproducer', risks: 'Wait for test' }
            ],
            questions: [
                { id: 'Q-1', text: 'Does API gateway filter nulls?' }
            ],
            analyzedAt: new Date().toISOString()
        },
        decisions: [],
        applications: [],
        updatedAt: new Date().toISOString()
    };

    context.fetch = async (url) => {
        if (url.includes('case-11111111')) {
            return { ok: true, json: async () => mockCase };
        }
        return { ok: false, json: async () => ({}) };
    };

    await app.selectCase('case-11111111-2222-3333-4444-555555555555');

    const detailHtml = elements.get('decisionCaseDetail').innerHTML;
    assert.match(detailHtml, /Empty string dispute/);
    assert.match(detailHtml, /Should empty string be permitted\?/);
    assert.match(detailHtml, /Null pointer hazard/);
    assert.match(detailHtml, /VERIFY_MORE/);
    assert.match(detailHtml, /Q-1: Does API gateway filter nulls\?/);
    assert.match(detailHtml, /decisionAction/);
    assert.match(detailHtml, /decisionNote/);
});
