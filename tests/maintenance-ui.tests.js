/**
 * @file maintenance-ui.tests.js
 * @author shuyongqiang
 * @description Unit tests for Maintenance frontend controller (export, archive, storage overview, imports).
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
            this.innerText = '';
            this.textContent = '';
            this.checked = false;
            this.disabled = false;
            this.style = {};
            this.children = [];
            this.classList = {
                classes: new Set(),
                add: cls => this.classList.classes.add(cls),
                remove: cls => this.classList.classes.delete(cls),
                toggle: (cls, force) => {
                    if (force !== undefined) {
                        if (force) this.classList.classes.add(cls);
                        else this.classList.classes.delete(cls);
                    } else {
                        if (this.classList.classes.has(cls)) this.classList.classes.delete(cls);
                        else this.classList.classes.add(cls);
                    }
                },
                contains: cls => this.classList.classes.has(cls)
            };
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
        remove() {}
        click() {
            this.clicked = true;
        }
    }

    const reg = (id, tag = 'div') => {
        const el = new MockElement(tag);
        el.id = id;
        elements.set(id, el);
        return el;
    };

    // Export modal elements
    reg('exportEvidenceModal');
    reg('exportAuditIdDisplay');
    reg('exportPlanPreview');
    reg('exportIncludeArtifacts', 'input').checked = true;
    reg('exportRedactPaths', 'input').checked = true;

    // Archive modal elements
    reg('archiveGroupModal');
    reg('archiveAuditIdDisplay');
    reg('archivePreviewContent');
    reg('archiveNoteInput', 'input').value = 'Test note';
    reg('btnConfirmArchive', 'button');

    // Storage overview & diagnostics elements
    reg('storageModal');
    reg('maintTotalRecords');
    reg('maintTotalAttachments');
    reg('maintArchivedCount');
    reg('maintTotalDisk');
    reg('storagePendingCount');
    reg('storageCorruptedCount');
    reg('storageTotalCount');
    reg('storagePlanDetails');
    reg('storageErrorsList');
    reg('storageActionResult');
    reg('btnApplyMigration', 'button');

    // Sub tabs & lists
    reg('tabBtnStorageDiag', 'button');
    reg('tabBtnStorageArchive', 'button');
    reg('tabBtnStorageImport', 'button');
    reg('storageSectionDiag');
    reg('storageSectionArchive');
    reg('storageSectionImport');
    reg('archivedGroupsList');
    reg('importedBundlesList');

    let toastCalls = [];
    let auditAppRefreshed = false;

    const context = {
        document: {
            getElementById: id => elements.get(id) || null,
            addEventListener: () => {},
            createElement: tag => new MockElement(tag),
            body: {
                appendChild: el => el
            }
        },
        window: {
            URL: {
                createObjectURL: () => 'blob:mock-url',
                revokeObjectURL: () => {}
            },
            auditApp: {
                refresh: async () => { auditAppRefreshed = true; }
            }
        },
        escapeHtml: str => String(str).replace(/[&<>"']/g, m => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[m])),
        fetch: null,
        showToast: (msg, type) => { toastCalls.push({ msg, type }); },
        console
    };

    vm.createContext(context);
    const code = fs.readFileSync(path.join(__dirname, '../public/maintenance.js'), 'utf8');
    vm.runInContext(code, context);

    return {
        context,
        elements,
        getToastCalls: () => toastCalls,
        didAuditAppRefresh: () => auditAppRefreshed
    };
}

test('maintenanceApp: openExportModal and refreshExportPlan correctly fetch plan and update DOM', async () => {
    const { context, elements } = setupDom();
    const app = context.window.maintenanceApp;

    let requestedUrl = '';
    context.fetch = async (url) => {
        requestedUrl = url;
        return {
            ok: true,
            status: 200,
            json: async () => ({
                auditId: 'audit-12345678',
                version: 1,
                recordRefs: [{ kind: 'audits', id: 'audit-12345678' }],
                artifactRefs: [{ path: 'run.log', size: 1024 }],
                estimatedBytes: 2048,
                warnings: [{ message: 'Minor warning' }],
                omissions: []
            })
        };
    };

    await app.openExportModal('audit-12345678');

    assert.equal(elements.get('exportEvidenceModal').style.display, 'flex');
    assert.equal(elements.get('exportAuditIdDisplay').innerText, 'audit-12345678');
    assert.match(requestedUrl, /\/api\/audits\/audit-12345678\/export-plan/);
    assert.match(elements.get('exportPlanPreview').innerHTML, /关联记录总数/);
    assert.match(elements.get('exportPlanPreview').innerHTML, /Minor warning/);

    app.closeExportModal();
    assert.equal(elements.get('exportEvidenceModal').style.display, 'none');
});

test('maintenanceApp: downloadExport fetches bundle and triggers browser download', async () => {
    const { context, elements, getToastCalls } = setupDom();
    const app = context.window.maintenanceApp;

    context.fetch = async (url, opts) => {
        if (url.includes('/export-plan')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    version: 1,
                    recordRefs: [{ kind: 'audits', id: 'audit-12345678' }],
                    artifactRefs: [],
                    estimatedBytes: 500
                })
            };
        }
        if (url.includes('/export-bundle')) {
            assert.equal(opts.method, 'POST');
            const body = JSON.parse(opts.body);
            assert.equal(body.format, 'json');
            return {
                ok: true,
                status: 200,
                blob: async () => ({ size: 500 })
            };
        }
        throw new Error('Unexpected URL: ' + url);
    };

    await app.openExportModal('audit-12345678');
    await app.downloadExport('json');

    assert.equal(elements.get('exportEvidenceModal').style.display, 'none');
    assert(getToastCalls().some(t => t.msg.includes('下载成功') && t.type === 'success'));
});

test('maintenanceApp: openArchiveModal displays preview and confirmArchive invokes API and refreshes auditApp', async () => {
    const { context, elements, didAuditAppRefresh } = setupDom();
    const app = context.window.maintenanceApp;

    context.fetch = async (url, opts) => {
        if (url.includes('/archive-preview')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    primaryAuditId: 'audit-9999',
                    version: 1,
                    recordRefs: [{ kind: 'audits', id: 'audit-9999' }],
                    blockers: []
                })
            };
        }
        if (url.includes('/archive-apply')) {
            assert.equal(opts.method, 'POST');
            const body = JSON.parse(opts.body);
            assert.equal(body.version, 1);
            assert.equal(body.note, 'Test note');
            return {
                ok: true,
                status: 200,
                json: async () => ({ ok: true })
            };
        }
        throw new Error('Unexpected URL: ' + url);
    };

    await app.openArchiveModal('audit-9999');
    assert.equal(elements.get('archiveGroupModal').style.display, 'flex');
    assert.equal(elements.get('btnConfirmArchive').disabled, false);
    assert.match(elements.get('archivePreviewContent').innerHTML, /audit-9999/);

    await app.confirmArchive();
    assert.equal(elements.get('archiveGroupModal').style.display, 'none');
    assert.equal(didAuditAppRefresh(), true);
});

test('maintenanceApp: loadStorageOverview updates metrics elements', async () => {
    const { context, elements } = setupDom();
    const app = context.window.maintenanceApp;

    context.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
            summary: {
                totalRecords: 42,
                totalAttachmentFiles: 10,
                totalAttachmentBytes: 204800,
                totalArchived: 5,
                totalStoreBytes: 10485760
            }
        })
    });

    await app.loadStorageOverview();

    assert.equal(elements.get('maintTotalRecords').innerText, 42);
    assert.match(elements.get('maintTotalAttachments').innerText, /10 个/);
    assert.equal(elements.get('maintArchivedCount').innerText, 5);
    assert.match(elements.get('maintTotalDisk').innerText, /10.00 MB/);
});

test('maintenanceApp: switchStorageSubTab toggles active section visibility and class', () => {
    const { context, elements } = setupDom();
    const app = context.window.maintenanceApp;

    context.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => []
    });

    app.switchStorageSubTab('archive');
    assert.equal(elements.get('storageSectionDiag').style.display, 'none');
    assert.equal(elements.get('storageSectionArchive').style.display, 'block');
    assert.equal(elements.get('storageSectionImport').style.display, 'none');
    assert.equal(elements.get('tabBtnStorageArchive').classList.contains('active'), true);
    assert.equal(elements.get('tabBtnStorageDiag').classList.contains('active'), false);

    app.switchStorageSubTab('import');
    assert.equal(elements.get('storageSectionImport').style.display, 'block');
    assert.equal(elements.get('storageSectionArchive').style.display, 'none');
    assert.equal(elements.get('tabBtnStorageImport').classList.contains('active'), true);
});
