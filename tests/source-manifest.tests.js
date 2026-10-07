'use strict';
/**
 * 2.12 Task 1: Source Manifest & Change Analysis unit tests.
 * @author shuyongqiang
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createFixture } = require('./helpers/studio-fixture');
const { sourceSnapshot } = require('../engine/workflow');
const {
    buildManifest,
    compareManifests,
    computeLegacySnapshot
} = require('../engine/source-manifest');

test('buildManifest: generates deterministic manifest and matches sourceSnapshot', async (t) => {
    const f = createFixture(t);
    fs.unlinkSync(path.join(f.workspace, 'app.js'));
    // Create source files in fixture
    fs.writeFileSync(path.join(f.workspace, 'a.js'), 'const a = 1;\n', 'utf8');
    fs.writeFileSync(path.join(f.workspace, 'b.js'), 'const b = 2;\n', 'utf8');
    fs.mkdirSync(path.join(f.workspace, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(f.workspace, 'sub', 'c.js'), 'const c = 3;\n', 'utf8');

    // Create studio internal dir to verify exclusion
    fs.mkdirSync(path.join(f.workspace, '.studio'), { recursive: true });
    fs.writeFileSync(path.join(f.workspace, '.studio', 'state.json'), '{}', 'utf8');

    const manifest = await buildManifest(f.workspace);
    assert.equal(manifest.version, 1);
    assert.equal(manifest.complete, true);
    assert.equal(manifest.entries.length, 3);
    assert.deepEqual(manifest.entries.map(e => e.path), ['a.js', 'b.js', 'sub/c.js']);

    const snapshot = await sourceSnapshot(f.workspace);
    assert.equal(manifest.snapshot, snapshot);

    // Verify entry schema
    for (const entry of manifest.entries) {
        assert.equal(typeof entry.path, 'string');
        assert.equal(entry.kind, 'file');
        assert.equal(typeof entry.mode, 'number');
        assert.equal(typeof entry.size, 'number');
        assert.equal(typeof entry.sha256, 'string');
        assert.equal(entry.sha256.length, 64);
    }
});

test('compareManifests: identical manifests produce empty changes', async (t) => {
    const f = createFixture(t);
    fs.unlinkSync(path.join(f.workspace, 'app.js'));
    fs.writeFileSync(path.join(f.workspace, 'index.js'), 'console.log("hello");\n', 'utf8');
    const m1 = await buildManifest(f.workspace);
    const m2 = await buildManifest(f.workspace);

    const diff = compareManifests(m1, m2);
    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.modified, []);
    assert.deepEqual(diff.deleted, []);
    assert.deepEqual(diff.unchanged, ['index.js']);
    assert.deepEqual(diff.renameCandidates, []);
    assert.equal(diff.requiresFullAudit, false);
    assert.equal(diff.reasons.length, 0);
});

test('compareManifests: detects added, modified, deleted files and renames', async (t) => {
    const f = createFixture(t);
    fs.unlinkSync(path.join(f.workspace, 'app.js'));
    fs.writeFileSync(path.join(f.workspace, 'keep.js'), 'const keep = true;\n', 'utf8');
    fs.writeFileSync(path.join(f.workspace, 'modify.js'), 'const v = 1;\n', 'utf8');
    fs.writeFileSync(path.join(f.workspace, 'old-name.js'), 'const moved = 42;\n', 'utf8');

    const before = await buildManifest(f.workspace);

    // Perform modifications
    fs.writeFileSync(path.join(f.workspace, 'modify.js'), 'const v = 2;\n', 'utf8');
    fs.unlinkSync(path.join(f.workspace, 'old-name.js'));
    fs.writeFileSync(path.join(f.workspace, 'new-name.js'), 'const moved = 42;\n', 'utf8'); // renamed
    fs.writeFileSync(path.join(f.workspace, 'brand-new.js'), 'const fresh = true;\n', 'utf8'); // added

    const after = await buildManifest(f.workspace);

    const diff = compareManifests(before, after);
    assert.deepEqual(diff.added, ['brand-new.js', 'new-name.js']);
    assert.deepEqual(diff.modified, ['modify.js']);
    assert.deepEqual(diff.deleted, ['old-name.js']);
    assert.deepEqual(diff.unchanged, ['keep.js']);

    // Rename candidate
    assert.equal(diff.renameCandidates.length, 1);
    assert.equal(diff.renameCandidates[0].from, 'old-name.js');
    assert.equal(diff.renameCandidates[0].to, 'new-name.js');

    // Deletion triggers requiresFullAudit
    assert.equal(diff.requiresFullAudit, true);
    assert(diff.reasons.some(r => r.includes('DELETED_FILES_DETECTED')));
});

test('compareManifests: global configuration changes require full audit', async (t) => {
    const f = createFixture(t);
    fs.writeFileSync(path.join(f.workspace, 'package.json'), '{"name":"test"}\n', 'utf8');
    fs.writeFileSync(path.join(f.workspace, 'src.js'), 'console.log(1);\n', 'utf8');

    const before = await buildManifest(f.workspace);

    // Modify package.json
    fs.writeFileSync(path.join(f.workspace, 'package.json'), '{"name":"test","version":"1.0.1"}\n', 'utf8');

    const after = await buildManifest(f.workspace);
    const diff = compareManifests(before, after);

    assert.equal(diff.requiresFullAudit, true);
    assert(diff.reasons.some(r => r.includes('GLOBAL_CONFIG_CHANGED')));
});

test('compareManifests: missing or mismatched base manifest requires full audit', async (t) => {
    const f = createFixture(t);
    fs.writeFileSync(path.join(f.workspace, 'app.js'), 'console.log(1);\n', 'utf8');
    const manifest = await buildManifest(f.workspace);

    // Null base
    const diffNoBase = compareManifests(null, manifest);
    assert.equal(diffNoBase.requiresFullAudit, true);
    assert(diffNoBase.reasons.some(r => r.includes('NO_BASE_MANIFEST')));

    // Workspace mismatch
    const mismatchedBase = { ...manifest, workspaceKey: 'different-workspace-key' };
    const diffMismatch = compareManifests(mismatchedBase, manifest);
    assert.equal(diffMismatch.requiresFullAudit, true);
    assert(diffMismatch.reasons.some(r => r.includes('WORKSPACE_MISMATCH')));
});

test('buildManifest: non-Git directory builds deterministic manifest and excludes target/build/node_modules', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'non-git-manifest-'));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    fs.writeFileSync(path.join(tmpDir, 'file1.txt'), 'content 1\n');
    fs.mkdirSync(path.join(tmpDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'dep.js'), 'ignored\n');
    fs.mkdirSync(path.join(tmpDir, '.studio'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.studio', 'state.json'), 'ignored\n');

    const manifest = await buildManifest(tmpDir);
    assert.equal(manifest.entries.length, 1);
    assert.equal(manifest.entries[0].path, 'file1.txt');
    assert.equal(manifest.complete, true);
});

test('buildManifest: rejects when directory is modified during scan', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'concurrency-manifest-'));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'initial\n');

    // Simulate file modification right after read by hooking fs.readFileSync once
    const origRead = fs.readFileSync;
    let hooked = false;
    fs.readFileSync = function (...args) {
        const res = origRead.apply(this, args);
        if (!hooked && typeof args[0] === 'string' && args[0].endsWith('test.txt')) {
            hooked = true;
            origRead.call(fs, args[0]); // read
            fs.writeFileSync(args[0], 'modified during scan\n');
        }
        return res;
    };

    try {
        await assert.rejects(() => buildManifest(tmpDir), /SOURCE_CHANGED/);
    } finally {
        fs.readFileSync = origRead;
    }
});

