'use strict';
const { execFile } = require('child_process');

function getProcessStartTime(pid) {
    return new Promise((resolve) => {
        if (process.platform === 'win32') {
            execFile('powershell', ['-NoProfile', '-Command', `try { (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToString("o") } catch { exit 1 }`], { timeout: 4000 }, (err, stdout) => {
                if (err) return resolve(null);
                const str = stdout.trim();
                resolve(str || null);
            });
        } else {
            execFile('ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 4000 }, (err, stdout) => {
                if (err) return resolve(null);
                const str = stdout.trim();
                resolve(str ? new Date(str).toISOString() : null);
            });
        }
    });
}

async function inspectProcess(pid, expectedStartedAt = null) {
    if (!pid || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
        return { state: 'EXITED', startedAt: null };
    }

    let alive = false;
    try {
        process.kill(pid, 0);
        alive = true;
    } catch (err) {
        if (err.code === 'ESRCH') {
            return { state: 'EXITED', startedAt: null };
        }
        if (err.code === 'EPERM') {
            return { state: 'UNKNOWN', startedAt: null };
        }
        return { state: 'UNKNOWN', startedAt: null };
    }

    if (!alive) {
        return { state: 'EXITED', startedAt: null };
    }

    const startedAt = await getProcessStartTime(pid);
    if (!startedAt) {
        if (pid === process.pid) {
            const fallbackStart = new Date(Date.now() - process.uptime() * 1000).toISOString();
            if (expectedStartedAt) {
                const diff = Math.abs(new Date(fallbackStart).getTime() - new Date(expectedStartedAt).getTime());
                if (diff > 15000) return { state: 'EXITED', startedAt: fallbackStart };
            }
            return { state: 'ALIVE', startedAt: fallbackStart };
        }
        return { state: 'UNKNOWN', startedAt: null };
    }

    if (expectedStartedAt) {
        const expectedTime = new Date(expectedStartedAt).getTime();
        const actualTime = new Date(startedAt).getTime();
        if (isNaN(expectedTime) || isNaN(actualTime) || Math.abs(expectedTime - actualTime) > 15000) {
            return { state: 'EXITED', startedAt };
        }
    }

    return { state: 'ALIVE', startedAt };
}

let cachedOwnStartTime = null;
async function getOwnProcessStartTime() {
    if (!cachedOwnStartTime) {
        cachedOwnStartTime = new Date(Date.now() - process.uptime() * 1000).toISOString();
    }
    return cachedOwnStartTime;
}

module.exports = {
    inspectProcess,
    getProcessStartTime,
    getOwnProcessStartTime
};

