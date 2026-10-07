'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RunStore, workspaceKey } = require('../../engine/run-store');

function createFixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-fixture-'));
    const workspace = path.join(root, 'project');
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'app.js'), 'const value=1;\n');
    t.after(() => {
        if (path.dirname(root) !== fs.realpathSync(os.tmpdir())) throw Error('UNSAFE_TEST_ROOT');
        fs.rmSync(root, { recursive: true, force: true });
    });
    return {
        root,
        workspace,
        store: new RunStore(path.join(root, 'state')),
        workspaceKey: workspaceKey(workspace)
    };
}

function copyV0Fixtures(store, workspace, wsKey = workspaceKey(workspace)) {
    const srcRoot = path.join(__dirname, '../fixtures/storage-v0');
    if (!fs.existsSync(srcRoot)) return;
    const realWs = fs.realpathSync(workspace);
    for (const kind of fs.readdirSync(srcRoot)) {
        const kindDir = path.join(srcRoot, kind);
        if (!fs.statSync(kindDir).isDirectory()) continue;
        for (const id of fs.readdirSync(kindDir)) {
            const idDir = path.join(kindDir, id);
            if (!fs.statSync(idDir).isDirectory()) continue;
            for (const file of fs.readdirSync(idDir)) {
                const srcFile = path.join(idDir, file);
                const raw = fs.readFileSync(srcFile, 'utf8');
                const parsed = JSON.parse(raw);
                const inject = (obj) => {
                    for (const [k, v] of Object.entries(obj)) {
                        if (v === '__WORKSPACE_ROOT__') obj[k] = realWs;
                        else if (v === '__WORKSPACE_KEY__') obj[k] = wsKey;
                        else if (v && typeof v === 'object') inject(v);
                    }
                };
                inject(parsed);
                const destFile = store.file(kind, id, file);
                fs.mkdirSync(path.dirname(destFile), { recursive: true });
                fs.writeFileSync(destFile, JSON.stringify(parsed, null, 2), 'utf8');
            }
        }
    }
}

module.exports = { createFixture, copyV0Fixtures };
