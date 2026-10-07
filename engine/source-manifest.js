'use strict';
/**
 * Source Manifest & Change Analysis (2.12 Task 1).
 *
 * Builds deterministic file-level manifest and compares before/after states.
 * Preserves 100% algorithm compatibility with existing sourceSnapshot.
 *
 * @author shuyongqiang
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { workspaceKey } = require('./run-store');
const { execute } = require('./process-runner');

const EXCLUDED_DIRS = [
    '.git',
    '.studio',
    'node_modules',
    '.ai-workspace',
    'target',
    'build',
    'dist',
    '.venv',
    '__pycache__'
];

const GLOBAL_CONFIG_REGEX = /^(package(-lock)?\.json|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|go\.(mod|sum)|Cargo\.(toml|lock)|requirements\.txt|pyproject\.toml|setup\.py|tsconfig\.json|CMakeLists\.txt|Makefile|Dockerfile|docker-compose.*|\.env.*)$/i;

function normalizePosix(p) {
    return p.replace(/\\/g, '/');
}

async function git(workspace, args, signal) {
    return execute('git', args, { cwd: workspace, signal, timeoutMs: 60000 });
}

async function enumerateSourceFiles(workspace, signal) {
    const repo = await git(workspace, ['rev-parse', '--show-toplevel'], signal);
    let files = [];
    let isGit = false;
    let headRef = 'UNBORN';

    if (repo.code === 0) {
        const head = await git(workspace, ['rev-parse', '--verify', 'HEAD'], signal);
        headRef = head.code === 0 ? head.stdout.trim() : 'UNBORN';
        const listing = await git(workspace, ['ls-files', '-c', '-o', '--exclude-standard', '-z', '--', '.'], signal);
        if (listing.code !== 0) throw new Error('SNAPSHOT_FAILED');
        files = [...new Set(listing.stdout.split('\0').filter(Boolean))];
        isGit = true;
    }

    if (!isGit || files.length === 0) {
        const walk = dir => {
            const targetDir = path.join(workspace, dir);
            if (!fs.existsSync(targetDir)) return;
            for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
                if (EXCLUDED_DIRS.includes(entry.name)) continue;
                const relative = dir ? path.join(dir, entry.name) : entry.name;
                if (entry.isDirectory()) {
                    walk(relative);
                } else {
                    files.push(relative);
                }
                if (files.length > 50000) throw new Error('SNAPSHOT_TOO_MANY_FILES');
            }
        };
        walk('');
    }

    // Filter studio / ai-workspace internal artifacts
    files = files.filter(f => !/^(\.studio|\.ai-workspace)[/\\]/.test(f));

    // Normalize paths to POSIX and sort identical to legacy sourceSnapshot (.sort())
    const normalized = files.map(normalizePosix);
    const sorted = [...new Set(normalized)].sort();

    return { files: sorted, isGit, headRef };
}

async function computeLegacySnapshot(workspace, signal, enumeration = null) {
    const enumResult = enumeration || await enumerateSourceFiles(workspace, signal);
    const digest = crypto.createHash('sha256');

    if (enumResult.isGit) {
        digest.update(enumResult.headRef);
    }

    for (const file of enumResult.files) {
        if (signal?.aborted) throw new Error('RUN_CANCELLED');
        digest.update(file);
        digest.update('\0');
        const target = path.join(workspace, file);
        let stat;
        try {
            stat = fs.lstatSync(target);
        } catch (error) {
            if (error.code === 'ENOENT') {
                digest.update('DELETED');
                continue;
            }
            throw error;
        }

        if (stat.isSymbolicLink()) {
            digest.update('LINK:' + fs.readlinkSync(target));
            continue;
        }
        if (stat.isDirectory()) {
            throw new Error(`SUBMODULE_REQUIRES_SEPARATE_RUN: ${file}`);
        }
        digest.update(String(stat.mode));

        for await (const chunk of fs.createReadStream(target)) {
            digest.update(chunk);
        }
        digest.update('\0');
    }

    return digest.digest('hex');
}

async function buildManifest(workspace, { signal } = {}) {
    if (!workspace || typeof workspace !== 'string') {
        throw new Error('INVALID_WORKSPACE: workspace must be a non-empty string');
    }
    const resolved = fs.realpathSync(workspace);
    if (!fs.statSync(resolved).isDirectory()) {
        throw new Error('INVALID_WORKSPACE: workspace must be a directory');
    }

    // 1. Initial snapshot check
    const initialEnumeration = await enumerateSourceFiles(resolved, signal);
    const initialSnapshot = await computeLegacySnapshot(resolved, signal, initialEnumeration);

    // 2. Scan file entries
    const entries = [];
    for (const relPath of initialEnumeration.files) {
        if (signal?.aborted) throw new Error('RUN_CANCELLED');
        const absPath = path.join(resolved, relPath);
        let stat;
        try {
            stat = fs.lstatSync(absPath);
        } catch (error) {
            if (error.code === 'ENOENT') {
                // File deleted during scan
                throw new Error('SOURCE_CHANGED: file deleted during manifest scan');
            }
            throw error;
        }

        let kind = 'file';
        let sha256 = '';
        let size = stat.size;

        if (stat.isSymbolicLink()) {
            kind = 'symlink';
            const linkTarget = fs.readlinkSync(absPath);
            sha256 = crypto.createHash('sha256').update(linkTarget).digest('hex');
        } else if (stat.isDirectory()) {
            throw new Error(`SUBMODULE_REQUIRES_SEPARATE_RUN: ${relPath}`);
        } else {
            const hash = crypto.createHash('sha256');
            const content = fs.readFileSync(absPath);
            hash.update(content);
            sha256 = hash.digest('hex');
        }

        entries.push({
            path: relPath,
            kind,
            mode: stat.mode,
            size,
            sha256
        });
    }

    // Sort entries deterministically by path (code unit sorting)
    entries.sort((a, b) => (a.path < b.path ? -1 : (a.path > b.path ? 1 : 0)));

    // 3. Post-scan snapshot check to ensure zero concurrency modifications
    const finalSnapshot = await computeLegacySnapshot(resolved, signal);
    if (initialSnapshot !== finalSnapshot) {
        throw new Error('SOURCE_CHANGED: workspace modified during manifest scan');
    }

    return {
        version: 1,
        workspaceKey: workspaceKey(resolved),
        snapshot: initialSnapshot,
        entries,
        complete: true,
        exclusions: [...EXCLUDED_DIRS]
    };
}

function compareManifests(before, after) {
    const reasons = [];
    let requiresFullAudit = false;

    if (!before || typeof before !== 'object' || !Array.isArray(before.entries)) {
        return {
            added: after && Array.isArray(after.entries) ? after.entries.map(e => e.path).sort() : [],
            modified: [],
            deleted: [],
            unchanged: [],
            renameCandidates: [],
            requiresFullAudit: true,
            reasons: ['NO_BASE_MANIFEST: Baseline manifest is missing or invalid']
        };
    }

    if (!after || typeof after !== 'object' || !Array.isArray(after.entries)) {
        return {
            added: [],
            modified: [],
            deleted: before.entries.map(e => e.path).sort(),
            unchanged: [],
            renameCandidates: [],
            requiresFullAudit: true,
            reasons: ['INVALID_TARGET_MANIFEST: Target manifest is missing or invalid']
        };
    }

    if (before.workspaceKey !== after.workspaceKey) {
        requiresFullAudit = true;
        reasons.push('WORKSPACE_MISMATCH: Base and target manifests belong to different workspaces');
    }

    const beforeMap = new Map();
    for (const e of before.entries) {
        beforeMap.set(e.path, e);
    }

    const afterMap = new Map();
    for (const e of after.entries) {
        afterMap.set(e.path, e);
    }

    const added = [];
    const modified = [];
    const unchanged = [];
    const deleted = [];

    for (const [p, afterEntry] of afterMap.entries()) {
        const beforeEntry = beforeMap.get(p);
        if (!beforeEntry) {
            added.push(p);
        } else {
            if (
                beforeEntry.sha256 === afterEntry.sha256 &&
                beforeEntry.mode === afterEntry.mode &&
                beforeEntry.kind === afterEntry.kind
            ) {
                unchanged.push(p);
            } else {
                modified.push(p);
            }
        }
    }

    for (const [p] of beforeMap.entries()) {
        if (!afterMap.has(p)) {
            deleted.push(p);
        }
    }

    // Detect candidate renames: deleted + added with exact matching sha256
    const renameCandidates = [];
    const addedEntries = added.map(p => afterMap.get(p));
    const deletedEntries = deleted.map(p => beforeMap.get(p));

    for (const del of deletedEntries) {
        if (del.kind !== 'file' || del.size === 0) continue;
        const matchingAdd = addedEntries.find(add => add.sha256 === del.sha256 && add.kind === 'file');
        if (matchingAdd) {
            renameCandidates.push({
                from: del.path,
                to: matchingAdd.path,
                sha256: del.sha256
            });
        }
    }

    // Sort all arrays deterministically (standard sort)
    added.sort();
    modified.sort();
    deleted.sort();
    unchanged.sort();
    renameCandidates.sort((a, b) => (a.from < b.from ? -1 : (a.from > b.from ? 1 : (a.to < b.to ? -1 : (a.to > b.to ? 1 : 0)))));

    // Full audit triggers
    // 1. Deleted files detected
    if (deleted.length > 0) {
        requiresFullAudit = true;
        reasons.push(`DELETED_FILES_DETECTED: ${deleted.length} file(s) deleted; deletions cannot be safely verified in isolation`);
    }

    // 2. Global configuration, build script, lockfile or dependency changes
    const configChanges = [...added, ...modified, ...deleted].filter(p => {
        const basename = path.basename(p);
        return GLOBAL_CONFIG_REGEX.test(basename) || GLOBAL_CONFIG_REGEX.test(p);
    });
    if (configChanges.length > 0) {
        requiresFullAudit = true;
        reasons.push(`GLOBAL_CONFIG_CHANGED: Critical build/configuration file(s) modified: ${configChanges.join(', ')}`);
    }

    // 3. Large change set
    const totalChanges = added.length + modified.length + deleted.length;
    if (totalChanges > 20) {
        requiresFullAudit = true;
        reasons.push(`LARGE_CHANGE_SET: Total changed files (${totalChanges}) exceeds targeted review threshold (20)`);
    }

    // 4. All files changed or empty unchanged
    if (unchanged.length === 0 && (added.length > 0 || modified.length > 0)) {
        requiresFullAudit = true;
        reasons.push('ALL_FILES_CHANGED: Entire codebase modified; requires comprehensive audit');
    }

    return {
        added,
        modified,
        deleted,
        unchanged,
        renameCandidates,
        requiresFullAudit,
        reasons
    };
}

module.exports = {
    buildManifest,
    compareManifests,
    computeLegacySnapshot,
    enumerateSourceFiles,
    EXCLUDED_DIRS,
    GLOBAL_CONFIG_REGEX
};
