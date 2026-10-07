/**
 * @file evidence-report.js
 * @author shuyongqiang
 * @description Offline HTML report renderer and read-only import validator (v2.14 Task 2).
 */
'use strict';

const crypto = require('crypto');
const { CURRENT_EXPORT_FORMAT_VERSION, MAX_RECORDS_BYTES, MAX_BUNDLE_BYTES, canonicalJson } = require('./evidence-export');

/**
 * Escapes text for safe inclusion in HTML.
 */
function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Validates an imported evidence bundle.
 * Ensures formatVersion, schema, limits, and cryptographically checks manifest hashes.
 */
function validateImportedBundle(bundle) {
    const errors = [];
    const manifestErrors = [];

    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
        return { ok: false, errors: ['INVALID_BUNDLE_OBJECT: Bundle must be an object'], manifestValid: false, manifestErrors: [] };
    }

    if (bundle.formatVersion !== CURRENT_EXPORT_FORMAT_VERSION) {
        errors.push(`UNSUPPORTED_FORMAT_VERSION: Bundle formatVersion '${bundle.formatVersion}' does not match supported version '${CURRENT_EXPORT_FORMAT_VERSION}'`);
    }

    if (typeof bundle.auditId !== 'string' || !/^[a-f0-9-]{36}$/.test(bundle.auditId)) {
        errors.push('INVALID_OR_MISSING_AUDIT_ID');
    }

    if (!bundle.records || typeof bundle.records !== 'object' || Array.isArray(bundle.records)) {
        errors.push('INVALID_OR_MISSING_RECORDS: records must be an object');
    }

    if (!Array.isArray(bundle.manifest) || bundle.manifest.length === 0) {
        errors.push('INVALID_OR_MISSING_MANIFEST: manifest must be a non-empty array');
    }

    if (!Array.isArray(bundle.limitations)) {
        errors.push('INVALID_OR_MISSING_LIMITATIONS: limitations must be an array');
    }

    if (errors.length > 0) {
        return { ok: false, errors, manifestValid: false, manifestErrors };
    }

    // Verify manifest entries
    const manifestNames = new Set();
    let recordsManifestFound = false;

    for (const item of bundle.manifest) {
        if (!item || typeof item !== 'object') {
            manifestErrors.push('INVALID_MANIFEST_ITEM');
            continue;
        }
        if (typeof item.name !== 'string' || !item.name.trim()) {
            manifestErrors.push('INVALID_MANIFEST_NAME');
            continue;
        }
        if (manifestNames.has(item.name)) {
            manifestErrors.push(`DUPLICATE_MANIFEST_ENTRY: ${item.name}`);
        }
        manifestNames.add(item.name);

        if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256)) {
            manifestErrors.push(`INVALID_MANIFEST_SHA256: ${item.name}`);
        }
        if (typeof item.bytes !== 'number' || !Number.isInteger(item.bytes) || item.bytes < 0) {
            manifestErrors.push(`INVALID_MANIFEST_BYTES: ${item.name}`);
        }

        if (item.name === 'records.json') {
            recordsManifestFound = true;
            // Verify records.json byte hash
            try {
                const canonical = canonicalJson(bundle.records);
                const actualSha = crypto.createHash('sha256').update(canonical).digest('hex');
                const actualBytes = Buffer.byteLength(canonical, 'utf8');

                if (actualSha.toLowerCase() !== item.sha256.toLowerCase()) {
                    manifestErrors.push(`RECORDS_SHA256_MISMATCH: expected ${item.sha256}, calculated ${actualSha}`);
                }
                if (actualBytes !== item.bytes) {
                    manifestErrors.push(`RECORDS_BYTES_MISMATCH: expected ${item.bytes}, actual ${actualBytes}`);
                }
                if (actualBytes > MAX_RECORDS_BYTES) {
                    errors.push(`RECORDS_SIZE_LIMIT_EXCEEDED: ${actualBytes} bytes exceeds ${MAX_RECORDS_BYTES}`);
                }
            } catch (err) {
                manifestErrors.push(`RECORDS_VERIFICATION_FAILED: ${err.message}`);
            }
        } else if (item.name.startsWith('artifacts/')) {
            // Verify artifact bytes and sha
            const art = bundle.artifacts?.[item.name];
            if (!art || typeof art !== 'object') {
                manifestErrors.push(`MISSING_DECLARED_ARTIFACT: ${item.name}`);
            } else if (typeof art.content === 'string') {
                try {
                    const buf = Buffer.from(art.content, 'base64');
                    const actualSha = crypto.createHash('sha256').update(buf).digest('hex');
                    if (actualSha.toLowerCase() !== item.sha256.toLowerCase()) {
                        manifestErrors.push(`ARTIFACT_SHA256_MISMATCH: ${item.name}`);
                    }
                    if (buf.length !== item.bytes) {
                        manifestErrors.push(`ARTIFACT_BYTES_MISMATCH: ${item.name}`);
                    }
                } catch (err) {
                    manifestErrors.push(`ARTIFACT_DECODE_FAILED: ${item.name}`);
                }
            } else {
                manifestErrors.push(`INVALID_ARTIFACT_CONTENT: ${item.name}`);
            }
        } else {
            manifestErrors.push(`UNRECOGNIZED_MANIFEST_ITEM: ${item.name}`);
        }
    }

    if (!recordsManifestFound) {
        manifestErrors.push('RECORDS_MANIFEST_MISSING: records.json not declared in manifest');
    }

    const allErrors = [...errors, ...manifestErrors];
    return {
        ok: allErrors.length === 0,
        errors: allErrors,
        manifestValid: manifestErrors.length === 0,
        manifestErrors
    };
}

/**
 * Renders a self-contained, strictly sanitized, offline HTML report from an evidence bundle.
 * Completely disarms script execution, external CSS/images, and JavaScript URL schemes.
 */
function renderReport(bundle) {
    const esc = escapeHtml;

    const audits = bundle.records?.audits || [];
    const rootAudit = audits.find(a => a.id === bundle.auditId) || audits[0] || {};
    const findings = rootAudit.findings || [];
    const reviewers = rootAudit.reviewers || [];
    const decisionCases = bundle.records?.['decision-cases'] || [];
    const runs = bundle.records?.runs || [];
    const plans = bundle.records?.plans || [];

    const artifactsList = Object.keys(bundle.artifacts || {});

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src data:; base-uri 'none';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dual-Agent Studio | 离线只读证据报告 - ${esc(bundle.auditId)}</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #3b82f6;
      --danger: #ef4444;
      --warning: #f59e0b;
      --success: #10b981;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      margin: 0;
      padding: 24px;
    }
    .container {
      max-width: 1100px;
      margin: 0 auto;
    }
    .alert-banner {
      background: rgba(245, 158, 11, 0.15);
      border: 1px solid var(--warning);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 24px;
    }
    .alert-banner h3 {
      margin: 0 0 8px 0;
      color: var(--warning);
      font-size: 16px;
    }
    .alert-banner ul {
      margin: 0;
      padding-left: 20px;
      font-size: 13px;
      color: var(--text-muted);
    }
    .header-box {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 24px;
    }
    .header-box h1 {
      margin: 0 0 8px 0;
      font-size: 22px;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 12px;
      margin-top: 14px;
      font-size: 13px;
    }
    .meta-item strong {
      display: block;
      color: var(--text-muted);
      font-size: 11px;
      text-transform: uppercase;
    }
    .section-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 24px;
    }
    .section-card h2 {
      margin: 0 0 14px 0;
      font-size: 17px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
    }
    .finding-card {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border);
      border-left: 4px solid var(--danger);
      border-radius: 6px;
      padding: 14px;
      margin-bottom: 14px;
    }
    .finding-card.severity-MEDIUM { border-left-color: var(--warning); }
    .finding-card.severity-LOW { border-left-color: var(--accent); }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
    }
    .badge-danger { background: rgba(239, 68, 68, 0.2); color: #f87171; }
    .badge-warning { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
    .badge-info { background: rgba(59, 130, 246, 0.2); color: #60a5fa; }
    .badge-success { background: rgba(16, 185, 129, 0.2); color: #34d399; }
    pre {
      background: #000;
      padding: 10px;
      border-radius: 4px;
      overflow-x: auto;
      font-family: monospace;
      font-size: 12px;
      color: #e2e8f0;
      white-space: pre-wrap;
      word-break: break-all;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      margin-top: 10px;
    }
    th, td {
      border: 1px solid var(--border);
      padding: 8px 10px;
      text-align: left;
    }
    th {
      background: rgba(255, 255, 255, 0.04);
      color: var(--text-muted);
    }
    code {
      font-family: monospace;
      font-size: 12px;
      color: #93c5fd;
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- READ-ONLY DISCLAIMER BANNER -->
    <div class="alert-banner">
      <h3>⚠️ 外部历史报告（离线只读），当前源码有效性未知</h3>
      <ul>
        <li>本报告仅作为历史审查、争议记录与测试证据的离线快照，<strong>不构成当前工程执行授权</strong>。</li>
        <li>即便历史状态显示为通过或已批准，也不得在本地环境中自动执行命令或关闭当前缺陷。</li>
        <li>哈希清单仅验证导出包内文件字节完整性，不证明内容绝对真实性或作者数字身份。</li>
      </ul>
    </div>

    <!-- HEADER INFO -->
    <div class="header-box">
      <h1>📋 Dual-Agent Studio 审查证据与决策报告</h1>
      <div class="meta-grid">
        <div class="meta-item">
          <strong>审查记录 ID</strong>
          <code>${esc(bundle.auditId)}</code>
        </div>
        <div class="meta-item">
          <strong>导出时间</strong>
          <span>${esc(bundle.generatedAt)}</span>
        </div>
        <div class="meta-item">
          <strong>格式版本</strong>
          <span>Format v${esc(bundle.formatVersion)}</span>
        </div>
        <div class="meta-item">
          <strong>脱敏状态</strong>
          <span>${bundle.redacted ? '✅ 路径已执行通用占位符替换' : '⚠️ 未脱敏原始路径'}</span>
        </div>
      </div>
    </div>

    <!-- AUDIT OVERVIEW & FINDINGS -->
    <div class="section-card">
      <h2>🔍 审查发现列表 (${findings.length} 项)</h2>
      <p style="font-size: 12px; color: var(--text-muted);">
        审查范围: <code>${esc(rootAudit.scope || '全工程')}</code> ·
        审查员数量: <strong>${reviewers.length}</strong> ·
        发现分类: BUG / 风险 / 建议
      </p>

      ${findings.length === 0 ? '<p style="color: var(--text-muted); font-size: 13px;">无审查发现记录。</p>' : ''}
      ${findings.map((f, idx) => `
        <div class="finding-card severity-${esc(f.severity)}">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
            <strong style="font-size: 14px;">#${idx + 1} [${esc(f.category)}] ${esc(f.problem)}</strong>
            <span class="badge ${f.severity === 'CRITICAL' || f.severity === 'HIGH' ? 'badge-danger' : f.severity === 'MEDIUM' ? 'badge-warning' : 'badge-info'}">
              ${esc(f.severity)}
            </span>
          </div>
          <p style="margin: 4px 0; font-size: 12px;">文件位置: <code>${esc(f.file)}:${esc(f.lineRange || '-')}</code></p>
          ${f.evidence ? `<pre>证据代码:\n${esc(f.evidence)}</pre>` : ''}
          ${f.acceptance ? `<p style="font-size: 12px; margin: 4px 0;"><strong>验收条件:</strong> ${esc(f.acceptance)}</p>` : ''}
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 6px;">
            分诊状态: <span class="badge badge-info">${esc(rootAudit.triage?.[f.id]?.status || 'UNREVIEWED')}</span>
            ${rootAudit.triage?.[f.id]?.note ? `· 理由: ${esc(rootAudit.triage[f.id].note)}` : ''}
          </div>
        </div>
      `).join('')}
    </div>

    <!-- DECISION CASES -->
    ${decisionCases.length > 0 ? `
      <div class="section-card">
        <h2>⚖️ 争议处理与人工决策事项 (${decisionCases.length} 项)</h2>
        ${decisionCases.map(c => `
          <div style="border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin-bottom: 12px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <strong>${esc(c.title)}</strong>
              <span class="badge badge-warning">${esc(c.status)}</span>
            </div>
            <p style="margin: 6px 0; font-size: 13px;"><strong>核心问题:</strong> ${esc(c.question)}</p>
            ${c.analysis ? `
              <div style="background: rgba(255,255,255,0.02); padding: 8px; border-radius: 4px; font-size: 12px; margin: 8px 0;">
                <strong>仲裁分析建议:</strong>
                <p style="margin: 4px 0;">${esc(c.analysis.summary)}</p>
              </div>
            ` : ''}
            ${(c.decisions || []).length > 0 ? `
              <div style="font-size: 12px; margin-top: 8px;">
                <strong>已记录人工决策:</strong>
                ${c.decisions.map(d => `
                  <div style="padding: 4px 0; border-top: 1px dashed var(--border);">
                    <span class="badge badge-success">${esc(d.action)}</span> - ${esc(d.note)}
                    <span style="color: var(--text-muted); font-size: 11px;">(${esc(d.decidedAt)})</span>
                  </div>
                `).join('')}
              </div>
            ` : ''}
          </div>
        `).join('')}
      </div>
    ` : ''}

    <!-- RUNS & PLANS SUMMARY -->
    ${(runs.length > 0 || plans.length > 0) ? `
      <div class="section-card">
        <h2>🛠️ 关联运行与修复记录</h2>
        <p style="font-size: 12px; color: var(--text-muted);">
          关联运行轮次: <strong>${runs.length}</strong> 次 ·
          关联方案设计: <strong>${plans.length}</strong> 份
        </p>
        ${runs.map(r => `
          <div style="font-size: 12px; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
            运行 ID: <code>${esc(r.id)}</code> · 轮次: ${esc(r.round)}/${esc(r.maxRounds)} · 状态: <span class="badge badge-info">${esc(r.status)}</span>
          </div>
        `).join('')}
      </div>
    ` : ''}

    <!-- MANIFEST & CRYPTOGRAPHIC CHECKSUMS -->
    <div class="section-card">
      <h2>🔒 证据清单与哈希校验 (Manifest)</h2>
      <p style="font-size: 12px; color: var(--text-muted);">
        以下哈希由导出器在生成时严格计算，用于离线校验导出包内部文件字节完整性。
      </p>
      <table>
        <thead>
          <tr>
            <th>条目名称 (File Name)</th>
            <th>字节大小 (Bytes)</th>
            <th>SHA-256 校验和</th>
          </tr>
        </thead>
        <tbody>
          ${(bundle.manifest || []).map(m => `
            <tr>
              <td><code>${esc(m.name)}</code></td>
              <td>${esc(m.bytes)} bytes</td>
              <td><code style="font-size: 11px;">${esc(m.sha256)}</code></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <!-- ATTACHMENTS LIST -->
    ${artifactsList.length > 0 ? `
      <div class="section-card">
        <h2>📎 包含的附件清单 (${artifactsList.length} 项)</h2>
        <ul style="font-size: 12px; color: var(--text-muted);">
          ${artifactsList.map(a => `<li><code>${esc(a)}</code> (${bundle.artifacts[a].bytes} bytes)</li>`).join('')}
        </ul>
      </div>
    ` : ''}

    <!-- LIMITATIONS -->
    <div class="section-card" style="background: rgba(255,255,255,0.01);">
      <h2>ℹ️ 使用限制与安全声明 (Limitations)</h2>
      <ul style="font-size: 12px; color: var(--text-muted); margin: 0; padding-left: 20px;">
        ${(bundle.limitations || []).map(l => `<li>${esc(l)}</li>`).join('')}
      </ul>
    </div>
  </div>
</body>
</html>`;
}

module.exports = {
    escapeHtml,
    validateImportedBundle,
    renderReport
};
