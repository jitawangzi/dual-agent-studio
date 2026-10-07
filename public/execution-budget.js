'use strict';
/**
 * Dual-Agent Studio Execution Budget & Resource Accounting UI Component (2.11 Task 4).
 *
 * @author shuyongqiang
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.ExecutionBudgetUI = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function getBudgetConfig() {
        const presetEl = document.getElementById('budgetPreset');
        const attemptsEl = document.getElementById('budgetMaxAttempts');
        const secondsEl = document.getElementById('budgetMaxActiveSeconds');

        const preset = presetEl ? presetEl.value : 'unlimited';
        if (preset === 'conservative') {
            return { maxAttempts: 5, maxActiveSeconds: 300 };
        }
        if (preset === 'standard') {
            return { maxAttempts: 10, maxActiveSeconds: 900 };
        }
        if (preset === 'generous') {
            return { maxAttempts: 20, maxActiveSeconds: 1800 };
        }
        if (preset === 'custom') {
            const maxAttempts = attemptsEl && attemptsEl.value.trim() ? parseInt(attemptsEl.value.trim(), 10) : null;
            const maxActiveSeconds = secondsEl && secondsEl.value.trim() ? parseInt(secondsEl.value.trim(), 10) : null;
            if (maxAttempts === null && maxActiveSeconds === null) return null;
            return {
                maxAttempts: Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : null,
                maxActiveSeconds: Number.isInteger(maxActiveSeconds) && maxActiveSeconds > 0 ? maxActiveSeconds : null
            };
        }
        return null;
    }

    function onBudgetPresetChange() {
        const presetEl = document.getElementById('budgetPreset');
        const customRow = document.getElementById('budgetCustomInputs');
        const attemptsEl = document.getElementById('budgetMaxAttempts');
        const secondsEl = document.getElementById('budgetMaxActiveSeconds');

        if (!presetEl) return;
        const preset = presetEl.value;

        if (preset === 'custom') {
            if (customRow) customRow.style.display = 'flex';
        } else {
            if (customRow) customRow.style.display = 'none';
            if (preset === 'conservative') {
                if (attemptsEl) attemptsEl.value = '5';
                if (secondsEl) secondsEl.value = '300';
            } else if (preset === 'standard') {
                if (attemptsEl) attemptsEl.value = '10';
                if (secondsEl) secondsEl.value = '900';
            } else if (preset === 'generous') {
                if (attemptsEl) attemptsEl.value = '20';
                if (secondsEl) secondsEl.value = '1800';
            } else {
                if (attemptsEl) attemptsEl.value = '';
                if (secondsEl) secondsEl.value = '';
            }
        }
        refreshBudgetEstimate();
    }

    async function refreshBudgetEstimate() {
        const box = document.getElementById('budgetEstimateBox');
        if (!box) return;

        // Detect current tab or default to 'run'
        let kind = 'run';
        const activeTab = document.querySelector('.tab-btn.active');
        if (activeTab && activeTab.textContent.includes('审核')) kind = 'audit';
        else if (activeTab && activeTab.textContent.includes('讨论')) kind = 'planning';

        const config = {
            maxRounds: parseInt(document.getElementById('maxRounds')?.value, 10) || 4,
            maxSelfHealAttempts: parseInt(document.getElementById('maxSelfHealAttempts')?.value, 10) || 3
        };

        try {
            const res = await fetch('/api/estimate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind, config })
            });
            if (!res.ok) return;
            const data = await res.json();
            if (data.ok && data.estimate) {
                renderEstimateHtml(box, data.estimate);
            }
        } catch {
            // Silently ignore preflight estimate network issues
        }
    }

    function renderEstimateHtml(container, estimate) {
        const min = estimate.minimumAttempts;
        const max = estimate.maximumAttempts !== null ? `${estimate.maximumAttempts} 次` : '无确定上限';
        const assumptions = Array.isArray(estimate.assumptions) ? estimate.assumptions : [];

        container.innerHTML = `
            <div class="budget-estimate-card">
                <div class="budget-estimate-title">
                    <span>📊 启动前调用估算:</span>
                    <strong>最少 ${escapeHtml(min)} 次 / 最多约 ${escapeHtml(max)}</strong>
                </div>
                <div class="budget-estimate-assumptions">
                    ${assumptions.map(a => `<span class="assumption-tag">• ${escapeHtml(a)}</span>`).join(' ')}
                </div>
            </div>
        `;
    }

    function renderBudgetSummaryHtml(record) {
        if (!record) return '';
        const budget = record.budget || {};
        const limits = budget.limits || { maxAttempts: null, maxActiveSeconds: null };
        const reservations = Array.isArray(budget.reservations) ? budget.reservations : [];
        const settled = reservations.filter(r => r.status === 'SETTLED').length;
        const reserved = reservations.filter(r => r.status === 'RESERVED' || r.status === 'STARTED').length;

        const maxAttemptsText = limits.maxAttempts !== null ? `${limits.maxAttempts} 次` : '不限';
        const remainingAttempts = limits.maxAttempts !== null ? Math.max(0, limits.maxAttempts - (settled + reserved)) : null;
        const remainingAttemptsText = remainingAttempts !== null ? `${remainingAttempts} 次` : '不限';

        // Time tracking
        const tracking = budget.timeTracking || { totalActiveMs: 0 };
        const activeSeconds = Math.floor((tracking.totalActiveMs || 0) / 1000);
        const maxSecondsText = limits.maxActiveSeconds !== null ? `${limits.maxActiveSeconds} 秒` : '不限';
        const remainingSeconds = limits.maxActiveSeconds !== null ? Math.max(0, limits.maxActiveSeconds - activeSeconds) : null;
        const remainingSecondsText = remainingSeconds !== null ? `${remainingSeconds} 秒` : '不限';

        // Monetary Cost: Explicitly "未提供", NEVER false 0
        const costText = '未提供 (无外部计费适配器)';

        const uncertainNotice = tracking.uncertainActiveTime
            ? `<div class="budget-warn-badge">⚠️ 活跃时长包含未确认区间（服务曾异常重启）</div>`
            : '';

        return `
            <div class="budget-summary-panel">
                <div class="budget-metrics-grid">
                    <div class="budget-metric">
                        <span class="metric-label">调用次数</span>
                        <span class="metric-value">已用 ${settled} 次 ${reserved > 0 ? `(预留 ${reserved})` : ''} / 上限 ${maxAttemptsText}</span>
                        <span class="metric-sub">剩余: ${remainingAttemptsText}</span>
                    </div>
                    <div class="budget-metric">
                        <span class="metric-label">活跃耗时</span>
                        <span class="metric-value">运行 ${activeSeconds} 秒 / 上限 ${maxSecondsText}</span>
                        <span class="metric-sub">剩余: ${remainingSecondsText}</span>
                    </div>
                    <div class="budget-metric">
                        <span class="metric-label">核算费用</span>
                        <span class="metric-value" style="color: #94a3b8;">${costText}</span>
                        <span class="metric-sub">严禁伪造零元</span>
                    </div>
                </div>
                ${uncertainNotice}
            </div>
        `;
    }

    function renderCallAttemptsHtml(calls) {
        if (!Array.isArray(calls) || calls.length === 0) {
            return '<div class="text-muted" style="font-size: 12px; margin-top: 8px;">尚无模型调用尝试记录。</div>';
        }

        const rows = calls.map((c, index) => {
            const attemptNum = c.attemptIndex || (index + 1);
            const provider = escapeHtml(c.provider || 'unknown');
            const model = escapeHtml(c.model || 'default');
            const phase = escapeHtml(c.phase || c.role || 'task');
            const duration = c.durationMs ? `${(c.durationMs / 1000).toFixed(1)}s` : '-';
            const status = escapeHtml(c.status || 'STARTED');
            const isSuccess = status === 'COMPLETED';
            const errorCode = c.error ? escapeHtml(c.error.code || 'ERROR') : '';

            let badgeClass = 'badge-secondary';
            if (isSuccess) badgeClass = 'badge-success';
            else if (status === 'STARTED' || status === 'RESPONDED') badgeClass = 'badge-info';
            else badgeClass = 'badge-danger';

            return `
                <tr>
                    <td>#${attemptNum}</td>
                    <td><strong>${provider}</strong> <span style="font-size: 11px; color: #94a3b8;">(${model})</span></td>
                    <td>${phase}</td>
                    <td>${duration}</td>
                    <td><span class="status-pill ${badgeClass}">${status}</span></td>
                    <td style="color: #f87171; font-family: monospace; font-size: 11px;">${errorCode}</td>
                </tr>
            `;
        }).join('');

        return `
            <div class="call-attempts-table-container">
                <table class="call-attempts-table">
                    <thead>
                        <tr>
                            <th>序号</th>
                            <th>代理与模型</th>
                            <th>阶段 / 角色</th>
                            <th>耗时</th>
                            <th>状态</th>
                            <th>错误代码</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        `;
    }

    function renderBudgetPauseBanner(record, kind, onResumeCallback) {
        if (!record) return '';
        const isPausedByBudget = record.pauseReason === 'BUDGET_EXHAUSTED' ||
            record.reviewers?.some?.(r => r.pauseReason === 'BUDGET_EXHAUSTED');

        if (!isPausedByBudget) return '';

        const currentLimits = record.budget?.limits || {};
        const settled = (record.budget?.reservations || []).filter(r => r.status === 'SETTLED').length;
        const suggestedAttempts = Math.max((currentLimits.maxAttempts || settled) + 5, settled + 1);

        const currentActiveSec = Math.floor(((record.budget?.timeTracking?.totalActiveMs || 0) / 1000));
        const suggestedSec = Math.max((currentLimits.maxActiveSeconds || currentActiveSec) + 600, currentActiveSec + 60);

        const bannerId = `budget-pause-banner-${record.id}`;

        setTimeout(() => {
            const banner = document.getElementById(bannerId);
            if (!banner) return;

            const btnResume = banner.querySelector('.btn-budget-resume');
            const btnOnlyAdjust = banner.querySelector('.btn-budget-only');
            const attemptsInput = banner.querySelector('.input-new-attempts');
            const secondsInput = banner.querySelector('.input-new-seconds');
            const reasonInput = banner.querySelector('.input-adjust-reason');
            const errorMsg = banner.querySelector('.adjust-error-msg');

            const doAdjust = async (andResume) => {
                errorMsg.textContent = '';
                const reason = reasonInput.value.trim();
                if (!reason) {
                    errorMsg.textContent = '请填写调整原因（记录于审计日志）。';
                    return;
                }
                const newAttempts = parseInt(attemptsInput.value, 10);
                const newSeconds = parseInt(secondsInput.value, 10);

                if (!Number.isInteger(newAttempts) || newAttempts < settled) {
                    errorMsg.textContent = `最大尝试次数不能低于已消耗次数 (${settled})。`;
                    return;
                }

                try {
                    const adjustRes = await fetch(`/api/executions/${kind}/${record.id}/budget`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            workspaceRoot: record.workspaceRoot,
                            version: record.version,
                            budget: {
                                maxAttempts: newAttempts,
                                maxActiveSeconds: Number.isInteger(newSeconds) && newSeconds > 0 ? newSeconds : null
                            },
                            reason
                        })
                    });
                    const adjustData = await adjustRes.json();
                    if (!adjustRes.ok) {
                        if (adjustRes.status === 409) {
                            errorMsg.textContent = '版本冲突：该任务已在其他页面更新，请刷新重试。';
                        } else {
                            errorMsg.textContent = adjustData.error || '预算调整失败';
                        }
                        return;
                    }

                    if (andResume) {
                        const resumeRes = await fetch(`/api/executions/${kind}/${record.id}/resume-budget`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                workspaceRoot: record.workspaceRoot,
                                version: adjustData.version
                            })
                        });
                        const resumeData = await resumeRes.json();
                        if (!resumeRes.ok) {
                            if (resumeRes.status === 409 && resumeData.error === 'AUDIT_SOURCE_CHANGED') {
                                errorMsg.textContent = '源码已改变，请重新发起审核。';
                            } else {
                                errorMsg.textContent = resumeData.error || '恢复执行失败';
                            }
                            return;
                        }
                    }

                    if (typeof onResumeCallback === 'function') {
                        onResumeCallback();
                    }
                } catch (err) {
                    errorMsg.textContent = err.message || '网络请求异常';
                }
            };

            if (btnResume) btnResume.onclick = () => doAdjust(true);
            if (btnOnlyAdjust) btnOnlyAdjust.onclick = () => doAdjust(false);
        }, 0);

        return `
            <div id="${bannerId}" class="budget-pause-alert">
                <div class="pause-header">
                    <h4>⚠️ 任务因硬预算耗尽已暂停 (BUDGET_EXHAUSTED)</h4>
                    <p>已消耗 ${settled} 次模型调用尝试。为保证成本可控，系统已安全暂停，未完成的审核员或轮次处于等待恢复状态。</p>
                </div>
                <div class="pause-body">
                    <div class="form-row">
                        <div class="form-group flex-1">
                            <label>新最大尝试次数 (不可低于 ${settled})</label>
                            <input type="number" class="input-new-attempts" min="${settled}" value="${suggestedAttempts}">
                        </div>
                        <div class="form-group flex-1">
                            <label>新最大活跃时长 (秒)</label>
                            <input type="number" class="input-new-seconds" min="${currentActiveSec}" value="${suggestedSec}">
                        </div>
                    </div>
                    <div class="form-group">
                        <label>调整原因说明 (必填，载入历史记录)</label>
                        <input type="text" class="input-adjust-reason" placeholder="例如：用户追加 5 次额度以完成剩余两名审核员分析">
                    </div>
                    <div class="adjust-error-msg" style="color: #ef4444; font-size: 12px; margin-bottom: 8px;"></div>
                    <div class="pause-actions">
                        <button type="button" class="btn btn-primary btn-sm btn-budget-resume">⚡ 提高预算并恢复执行</button>
                        <button type="button" class="btn btn-secondary btn-sm btn-budget-only">仅更新预算</button>
                    </div>
                </div>
            </div>
        `;
    }

    return {
        getBudgetConfig,
        onBudgetPresetChange,
        refreshBudgetEstimate,
        renderEstimateHtml,
        renderBudgetSummaryHtml,
        renderCallAttemptsHtml,
        renderBudgetPauseBanner
    };
}));
