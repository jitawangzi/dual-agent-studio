'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { inspectProcess, getOwnProcessStartTime } = require('./process-owner');

const PROCESS_ACTIVE_ROOTS = new Map();

const now = () => new Date().toISOString();
function atomicJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp_${crypto.randomUUID()}`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(temp, file);
}

async function acquireReclaimMutex(mutexFile) {
    fs.mkdirSync(path.dirname(mutexFile), { recursive: true });
    for (let i = 0; i < 30; i++) {
        try {
            fs.writeFileSync(mutexFile, JSON.stringify({ pid: process.pid, time: Date.now() }), { flag: 'wx' });
            return true;
        } catch (err) {
            if (err.code !== 'EEXIST') throw err;
            try {
                const data = JSON.parse(fs.readFileSync(mutexFile, 'utf8'));
                if (data && data.pid) {
                    if (data.pid === process.pid) {
                        return true;
                    }
                    const proc = await inspectProcess(data.pid);
                    if (proc.state === 'EXITED' || Date.now() - (data.time || 0) > 5000) {
                        try { fs.unlinkSync(mutexFile); } catch {}
                        continue;
                    }
                }
            } catch {
                try { fs.unlinkSync(mutexFile); } catch {}
                continue;
            }
            await new Promise(r => setTimeout(r, 50));
        }
    }
    return false;
}

function releaseReclaimMutex(mutexFile) {
    try {
        if (fs.existsSync(mutexFile)) {
            const data = JSON.parse(fs.readFileSync(mutexFile, 'utf8'));
            if (data && data.pid === process.pid) {
                fs.unlinkSync(mutexFile);
            }
        }
    } catch {}
}

class RuntimeGuard {
    constructor(root) {
        this.root = path.resolve(root);
        this.lockFile = path.join(this.root, 'instance.lock');
        this.activeOwner = null;
        this.activeToken = null;
        this.activeStartedAt = null;
    }

    isBusy() {
        const normRoot = path.resolve(this.root);
        return this.activeOwner !== null || PROCESS_ACTIVE_ROOTS.has(normRoot);
    }

    acquire(owner) {
        if (!owner || typeof owner !== 'object') {
            throw new Error('INVALID_OWNER');
        }
        const { kind, id } = owner;
        if (!kind || typeof kind !== 'string') {
            throw new Error('INVALID_OWNER_KIND');
        }

        const normRoot = path.resolve(this.root);
        // CRITICAL: Pre-reserve the slot synchronously before any await
        if (this.activeOwner || PROCESS_ACTIVE_ROOTS.has(normRoot)) {
            const rejected = Promise.reject(new Error('WORKFLOW_BUSY: Workflow currently running'));
            rejected.catch(() => {});
            return rejected;
        }

        const token = crypto.randomUUID();
        const acquiredAt = now();
        this.activeOwner = { ...owner };
        this.activeToken = token;
        this.activeStartedAt = acquiredAt;
        PROCESS_ACTIVE_ROOTS.set(normRoot, { token, owner: this.activeOwner, guard: this });

        const runner = async () => {
            const reclaimMutex = path.join(path.dirname(this.lockFile), 'reclaim.mutex');
            try {
                if (fs.existsSync(this.lockFile)) {
                    let lockData = null;
                    try {
                        lockData = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'));
                    } catch {}

                    if (lockData && lockData.pid && lockData.pid !== process.pid) {
                        const proc = await inspectProcess(lockData.pid, lockData.processStartedAt || lockData.startedAt);
                        if (proc.state === 'ALIVE') {
                            this.release(token);
                            throw new Error('INSTANCE_LOCKED: Another Studio instance is actively running');
                        }
                        if (proc.state === 'UNKNOWN') {
                            this.release(token);
                            throw new Error('INSTANCE_LOCKED: Another instance status cannot be verified safely');
                        }
                        // If EXITED: old instance terminated without unlocking.
                        // Cross-process mutual exclusion protects the reclaim section.
                        const mutexAcquired = await acquireReclaimMutex(reclaimMutex);
                        if (!mutexAcquired) {
                            this.release(token);
                            throw new Error('INSTANCE_LOCKED: Another Studio instance is reclaiming lock');
                        }
                        try {
                            let curLock = null;
                            try { curLock = JSON.parse(fs.readFileSync(this.lockFile, 'utf8')); } catch {}
                            if (curLock && curLock.pid && curLock.pid !== process.pid) {
                                if (curLock.token !== lockData.token || curLock.pid !== lockData.pid) {
                                    const curProc = await inspectProcess(curLock.pid, curLock.processStartedAt || curLock.startedAt);
                                    if (curProc.state === 'ALIVE') {
                                        this.release(token);
                                        throw new Error('INSTANCE_LOCKED: Another Studio instance is actively running');
                                    }
                                    if (curProc.state === 'UNKNOWN') {
                                        this.release(token);
                                        throw new Error('INSTANCE_LOCKED: Another instance status cannot be verified safely');
                                    }
                                }
                            }
                            try { fs.unlinkSync(this.lockFile); } catch {}
                        } finally {
                            releaseReclaimMutex(reclaimMutex);
                        }
                    }
                }

                const ownStartTime = await getOwnProcessStartTime();
                const lockPayload = {
                    pid: process.pid,
                    processStartedAt: ownStartTime,
                    startedAt: ownStartTime,
                    owner: this.activeOwner,
                    token: this.activeToken,
                    acquiredAt
                };

                fs.mkdirSync(path.dirname(this.lockFile), { recursive: true });
                try {
                    fs.writeFileSync(this.lockFile, JSON.stringify(lockPayload, null, 2), { flag: 'wx', encoding: 'utf8' });
                } catch (writeErr) {
                    if (writeErr.code === 'EEXIST') {
                        let lockData = null;
                        try {
                            lockData = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'));
                        } catch {}
                        if (lockData && lockData.pid !== process.pid) {
                            const proc = await inspectProcess(lockData.pid, lockData.processStartedAt || lockData.startedAt);
                            if (proc.state === 'ALIVE' || proc.state === 'UNKNOWN') {
                                this.release(token);
                                throw new Error('INSTANCE_LOCKED: Another Studio instance is actively running');
                            }
                        }
                        const mutexAcquired = await acquireReclaimMutex(reclaimMutex);
                        if (!mutexAcquired) {
                            this.release(token);
                            throw new Error('INSTANCE_LOCKED: Another Studio instance is reclaiming lock');
                        }
                        try {
                            let curLock = null;
                            try { curLock = JSON.parse(fs.readFileSync(this.lockFile, 'utf8')); } catch {}
                            if (curLock && curLock.pid && curLock.pid !== process.pid) {
                                if (curLock.token !== lockData?.token || curLock.pid !== lockData?.pid) {
                                    const curProc = await inspectProcess(curLock.pid, curLock.processStartedAt || curLock.startedAt);
                                    if (curProc.state === 'ALIVE' || curProc.state === 'UNKNOWN') {
                                        this.release(token);
                                        throw new Error('INSTANCE_LOCKED: Another Studio instance is actively running');
                                    }
                                }
                            }
                            atomicJson(this.lockFile, lockPayload);
                        } finally {
                            releaseReclaimMutex(reclaimMutex);
                        }
                    } else {
                        throw writeErr;
                    }
                }

                return {
                    token,
                    owner: this.activeOwner,
                    release: () => this.release(token)
                };
            } catch (err) {
                if (this.activeToken === token) {
                    this.release(token);
                }
                throw err;
            }
        };

        const promise = runner();
        promise.catch(() => {});
        promise.token = token;
        promise.owner = this.activeOwner;
        promise.release = () => this.release(token);

        return promise;
    }

    release(token) {
        if (!token || this.activeToken !== token) {
            return false;
        }
        const normRoot = path.resolve(this.root);
        if (PROCESS_ACTIVE_ROOTS.get(normRoot)?.token === token) {
            PROCESS_ACTIVE_ROOTS.delete(normRoot);
        }
        this.activeOwner = null;
        this.activeToken = null;
        this.activeStartedAt = null;

        try {
            if (fs.existsSync(this.lockFile)) {
                let lockData = null;
                try {
                    lockData = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'));
                } catch {}
                if (lockData && lockData.pid === process.pid && lockData.token === token) {
                    fs.unlinkSync(this.lockFile);
                }
            }
        } catch {}
        return true;
    }

    async recover() {
        if (this.activeOwner) {
            return {
                state: 'BUSY',
                owner: this.activeOwner,
                reason: 'LOCAL_INSTANCE_BUSY'
            };
        }

        if (!fs.existsSync(this.lockFile)) {
            return {
                state: 'IDLE',
                owner: null,
                reason: null
            };
        }

        let lockData = null;
        try {
            lockData = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'));
        } catch {
            return {
                state: 'NEEDS_ATTENTION',
                owner: null,
                reason: 'CORRUPTED_LOCK_FILE'
            };
        }

        if (!lockData || !lockData.pid) {
            return {
                state: 'IDLE',
                owner: null,
                reason: null
            };
        }

        if (lockData.pid === process.pid) {
            return {
                state: 'NEEDS_ATTENTION',
                owner: lockData.owner,
                reason: 'ORPHAN_LOCAL_LOCK'
            };
        }

        const proc = await inspectProcess(lockData.pid, lockData.processStartedAt || lockData.startedAt);
        if (proc.state === 'ALIVE') {
            return {
                state: 'BUSY',
                owner: lockData.owner,
                reason: 'ANOTHER_INSTANCE_ALIVE'
            };
        }
        if (proc.state === 'UNKNOWN') {
            return {
                state: 'NEEDS_ATTENTION',
                owner: lockData.owner,
                reason: 'UNKNOWN_PROCESS_STATUS'
            };
        }
        return {
            state: 'NEEDS_ATTENTION',
            owner: lockData.owner,
            reason: 'ORPHAN_LOCK_PREVIOUS_EXITED'
        };
    }
}

module.exports = {
    RuntimeGuard
};
