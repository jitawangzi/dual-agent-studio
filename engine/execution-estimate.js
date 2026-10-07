'use strict';
/**
 * Execution Estimate (2.11 Task 4).
 *
 * Provides pre-flight call attempt range and scenario assumptions.
 * Strictly estimates call counts only; never fabricates monetary costs.
 * Strictly forbidden from spawning CLI or calling model APIs.
 *
 * @author shuyongqiang
 */

function estimateExecution(kind, config = {}) {
    if (!kind || typeof kind !== 'string') {
        throw new Error('INVALID_KIND: Execution kind must be a string');
    }

    const cfg = config && typeof config === 'object' ? config : {};

    switch (kind) {
        case 'run': {
            const isUnbounded = cfg.maxRounds === null;
            const maxRounds = isUnbounded ? null : ((typeof cfg.maxRounds === 'number' && cfg.maxRounds > 0) ? cfg.maxRounds : 4);
            const maxSelfHeal = (typeof cfg.maxSelfHealAttempts === 'number' && cfg.maxSelfHealAttempts > 0) ? cfg.maxSelfHealAttempts : 3;

            // Best case: 1 round, Dev turn (1) + Review turn (1) = 2 attempts.
            const minimumAttempts = 2;
            const maximumAttempts = maxRounds ? maxRounds * (1 + maxSelfHeal + 1) : null;
            const assumptions = [
                '顺利通过时至少需要 1 轮（包含 1 次 Dev 开发与 1 次 Reviewer 评审）',
                `测试门禁失败可能在每轮触发最多 ${maxSelfHeal} 次开发自愈重试`,
                maxRounds ? `评审未通过将进入下一轮，最多执行 ${maxRounds} 轮` : '未限制最大轮次，无法确定最大调用上限',
                '实际调用次数随代码测试通过率与评审一次性通过情况动态浮动'
            ];
            return { minimumAttempts, maximumAttempts, assumptions };
        }
        case 'audit': {
            const reviewers = Array.isArray(cfg.reviewers) ? cfg.reviewers : [];
            const count = reviewers.length > 0 ? reviewers.length : (typeof cfg.reviewerCount === 'number' && cfg.reviewerCount > 0 ? cfg.reviewerCount : 1);
            const minimumAttempts = count;
            const maximumAttempts = count * 2;
            const assumptions = [
                `${count} 位审核员各自至少执行 1 次独立工程代码审查`,
                '若审核员输出解析异常或环境中断，系统将触发重试',
                '不包含后续可选的人工验证探针与针对性补审调用'
            ];
            return { minimumAttempts, maximumAttempts, assumptions };
        }
        case 'planning': {
            const members = Array.isArray(cfg.members) ? cfg.members : [];
            const count = members.length > 0 ? members.length : 2;
            const isUnbounded = cfg.rounds === null;
            const rounds = isUnbounded ? null : ((typeof cfg.rounds === 'number' && cfg.rounds > 0) ? cfg.rounds : 2);
            const minimumAttempts = count * 1;
            const maximumAttempts = rounds ? count * rounds : null;
            const assumptions = [
                `${count} 位讨论成员在首轮各自输出初步设计与架构考量`,
                rounds ? `多轮方案对齐与分歧讨论最多进行 ${rounds} 轮` : '未限制讨论轮次，无法确定最大调用上限',
                '人工驳回并带着意见重新讨论将作为独立批次计入新预算'
            ];
            return { minimumAttempts, maximumAttempts, assumptions };
        }
        case 'health': {
            const count = Array.isArray(cfg.providers) ? cfg.providers.length : (typeof cfg.providerCount === 'number' && cfg.providerCount > 0 ? cfg.providerCount : 1);
            const minimumAttempts = Math.max(1, count);
            const maximumAttempts = minimumAttempts;
            const assumptions = [
                `针对选定的 ${minimumAttempts} 个代理提供方执行单次真实连通性探针`,
                '纯环境检查模式不消耗调用额度，仅测试连通探针消耗'
            ];
            return { minimumAttempts, maximumAttempts, assumptions };
        }
        default:
            throw new Error(`UNSUPPORTED_EXECUTION_KIND: '${kind}'`);
    }
}

module.exports = {
    estimateExecution
};
