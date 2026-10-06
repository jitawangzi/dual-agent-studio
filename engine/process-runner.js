'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function execute(command, args, { cwd, signal, timeoutMs = 1800000, onOutput = () => {}, onSpawn = () => {} } = {}) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('RUN_CANCELLED'));
        const proc = spawn(command, args, { cwd, windowsHide: true, shell: false,
            detached: process.platform !== 'win32', env: { ...process.env,
                http_proxy: process.env.http_proxy || 'http://127.0.0.1:10809',
                https_proxy: process.env.https_proxy || 'http://127.0.0.1:10809' } });
        let stdout = '', stderr = '', failure = null, settled = false;
        const limit = 4 * 1024 * 1024;
        const kill = reason => {
            if (failure) return;
            failure = new Error(reason);
            if (proc.pid) {
                if (process.platform === 'win32') {
                    const killer = spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true });
                    killer.on('error', () => proc.kill());
                } else { try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); } }
            }
        };
        const abort = () => kill('RUN_CANCELLED');
        const timer = setTimeout(() => kill('EXECUTION_TIMEOUT'), timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
        const notify = (callback, ...args) => {
            try { callback(...args); } catch (error) { kill(`PROCESS_CALLBACK_FAILED: ${error.message}`); }
        };
        proc.stdout.on('data', data => { stdout += data; notify(onOutput, data, 'stdout'); if (stdout.length > limit) kill('OUTPUT_LIMIT_EXCEEDED'); });
        proc.stderr.on('data', data => { stderr += data; notify(onOutput, data, 'stderr'); if (stderr.length > limit) kill('OUTPUT_LIMIT_EXCEEDED'); });
        proc.on('spawn', () => notify(onSpawn, proc));
        const done = (error, code) => {
            if (settled) return; settled = true;
            clearTimeout(timer); signal?.removeEventListener('abort', abort);
            if (error || failure) reject(error || failure); else resolve({ code, stdout, stderr });
        };
        proc.on('error', error => done(error));
        proc.on('close', code => done(null, code));
        proc.stdin.on('error', () => {}); proc.stdin.end();
    });
}
async function invokeAgent(request, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-agent-'));
    const input = path.join(directory, 'input.json'), output = path.join(directory, 'output.txt');
    fs.writeFileSync(input, JSON.stringify(request));
    try {
        const result = await execute('pwsh', ['-NoProfile', '-File', path.join(__dirname, 'agent-bridge.ps1'),
            '-RequestPath', input, '-OutputPath', output], { ...options, cwd: request.workspaceRoot });
        if (result.code !== 0) throw new Error(`AGENT_EXECUTION_FAILED (${result.code}): ${result.stderr || result.stdout}`);
        if (!fs.existsSync(output)) throw new Error('AGENT_OUTPUT_MISSING');
        const text = fs.readFileSync(output, 'utf8').trim();
        if (!text) throw new Error('AGENT_OUTPUT_EMPTY');
        return text;
    } finally {
        // Only remove the exact files created by this invocation.
        for (const file of [input, output]) { if (fs.existsSync(file)) fs.unlinkSync(file); }
        fs.rmdirSync(directory);
    }
}
module.exports = { execute, invokeAgent };
