// Pure helpers for the Claude Code → MemoMind relay hook (unit-tested).

import path from 'node:path';

const SECRET_PATTERNS = [
  [/\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,})/g, 'sk-•••'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,})/g, 'gh_•••'],
  [/\b(github_pat_[A-Za-z0-9_]{20,})/g, 'github_pat_•••'],
  [/\b(AKIA[0-9A-Z]{16})/g, 'AKIA•••'],
  [/\b(xox[abprs]-[A-Za-z0-9-]{10,})/g, 'xox•••'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1•••'],
  [/((?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1•••'],
  [/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, '$1•••$2'],
];

export function redact(text) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function truncate(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// Commands that need a two-step confirmation (nod, then button) on the glasses.
const HIGH_RISK_BASH = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/,         // rm -rf, rm -f, rm -r
  /\bgit\s+push\b.*(--force\b|--force-with-lease\b|\s-f\b)/,
  /\bgit\s+push\b.*\b(main|master|production|prod)\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+(clean\s+-[a-zA-Z]*f|branch\s+-D|filter-branch|filter-repo)\b/,
  /\bsudo\b/,
  /\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/,
  /\bchmod\s+(-R\s+)?777\b/,
  /\b(mkfs|dd\s+if=|shutdown|reboot)\b/,
  /\b(drop|truncate)\s+(table|database|schema)\b/i,
  /\b(npm|pnpm|yarn)\s+publish\b/,
  /\b(terraform|tofu)\s+(apply|destroy)\b/,
  /\bkubectl\s+(delete|apply|scale)\b/,
  /\b(wrangler|vercel|firebase|netlify|fly|flyctl)\s+(deploy|publish)\b/,
  /\bdocker\s+(system\s+prune|rm\s+-f|volume\s+rm)\b/,
];

export function classifyRisk(toolName, toolInput = {}, cwd = '') {
  if (toolName === 'Bash') {
    const command = String(toolInput.command || '');
    return HIGH_RISK_BASH.some((pattern) => pattern.test(command)) ? 'high' : 'normal';
  }
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    const file = String(toolInput.file_path || toolInput.notebook_path || '');
    if (file && cwd && !path.resolve(cwd, file).startsWith(path.resolve(cwd) + path.sep)) return 'high';
    if (/(^|\/)\.(env|ssh|aws|gnupg)(\/|$)|\.pem$|id_rsa/.test(file)) return 'high';
  }
  return 'normal';
}

// One-line, human summary of a tool call for the HUD.
export function describeTool(toolName, toolInput = {}, cwd = '') {
  const rel = (file) => {
    if (!file) return '';
    const resolved = path.resolve(cwd || '/', file);
    return cwd && resolved.startsWith(path.resolve(cwd) + path.sep) ? path.relative(cwd, resolved) : file;
  };
  switch (toolName) {
    case 'Bash':
      return { title: 'Run command', detail: toolInput.command || '' };
    case 'Write':
      return { title: 'Write file', detail: rel(toolInput.file_path) };
    case 'Edit':
    case 'MultiEdit':
      return { title: 'Edit file', detail: rel(toolInput.file_path) };
    case 'NotebookEdit':
      return { title: 'Edit notebook', detail: rel(toolInput.notebook_path) };
    case 'Read':
      return { title: 'Read file', detail: rel(toolInput.file_path) };
    case 'WebFetch':
      return { title: 'Fetch URL', detail: toolInput.url || '' };
    case 'WebSearch':
      return { title: 'Web search', detail: toolInput.query || '' };
    default: {
      const title = toolName?.startsWith('mcp__') ? `MCP ${toolName.split('__').slice(1).join(' › ')}` : `Use ${toolName}`;
      return { title, detail: JSON.stringify(toolInput) };
    }
  }
}

export function projectName(cwd) {
  return cwd ? path.basename(cwd) : '';
}

export function shortSession(id) {
  return String(id || '').slice(0, 8);
}

// Map a Claude Code hook payload to a relay feed event (or null to skip).
export function toFeedEvent(input) {
  const base = { session: shortSession(input.session_id), project: projectName(input.cwd) };
  switch (input.hook_event_name) {
    case 'SessionStart':
      return { ...base, kind: 'session', title: 'Session started', text: input.source || '' };
    case 'SessionEnd':
      return { ...base, kind: 'session', title: 'Session ended', text: input.reason || '' };
    case 'UserPromptSubmit':
      return { ...base, kind: 'prompt', title: 'New task', text: truncate(redact(input.prompt), 200) };
    case 'PostToolUse': {
      const { title, detail } = describeTool(input.tool_name, input.tool_input, input.cwd);
      return { ...base, kind: 'tool', title, text: truncate(redact(detail), 160) };
    }
    case 'Notification':
      if (input.notification_type === 'permission_prompt') return null; // covered by PermissionRequest
      return { ...base, kind: 'notify', title: input.title || 'Claude needs you', text: truncate(redact(input.message), 200) };
    case 'Stop':
      return { ...base, kind: 'done', title: 'Finished', text: truncate(redact(input.last_assistant_message), 200) };
    case 'SubagentStop':
      return { ...base, kind: 'status', title: `Subagent done${input.agent_type ? `: ${input.agent_type}` : ''}`, text: truncate(redact(input.last_assistant_message), 160) };
    default:
      return null;
  }
}

export function toAsk(input, timeoutMs) {
  const { title, detail } = describeTool(input.tool_name, input.tool_input, input.cwd);
  return {
    session: shortSession(input.session_id),
    project: projectName(input.cwd),
    title,
    detail: truncate(redact(detail), 300),
    risk: classifyRisk(input.tool_name, input.tool_input, input.cwd),
    timeoutMs,
  };
}

export function permissionOutput(behavior, message) {
  const decision = behavior === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message };
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}
