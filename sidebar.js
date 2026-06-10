/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ArkAI } from './ark.js';
import { DeepSeekAI } from './deepseek.js';

// The Gemini SDK is bundled by `npm install` (postinstall esbuild step) into
// js-genai.js, which is gitignored. Load it lazily so the rest of the sidebar -
// including the ARK provider, which doesn't need it - still works when the
// bundle is absent. A static import here would abort the whole module.
let GoogleGenAI;
async function loadGoogleGenAI() {
  if (!GoogleGenAI) ({ GoogleGenAI } = await import('./js-genai.js'));
  return GoogleGenAI;
}

// highlight.js bundle (also produced by `npm install`), loaded lazily.
let hljs;
async function loadHljs() {
  if (!hljs) ({ default: hljs } = await import('./hljs.js'));
  return hljs;
}

const statusDiv = document.getElementById('status');
const tbody = document.getElementById('tableBody');
const thead = document.getElementById('tableHeaderRow');
const copyToClipboard = document.getElementById('copyToClipboard');
const copyAsScriptToolConfig = document.getElementById('copyAsScriptToolConfig');
const copyAsJSON = document.getElementById('copyAsJSON');
const toolNames = document.getElementById('toolNames');
const inputArgsText = document.getElementById('inputArgsText');
const executeBtn = document.getElementById('executeBtn');
const toolResults = document.getElementById('toolResults');
const userPromptText = document.getElementById('userPromptText');
const promptBtn = document.getElementById('promptBtn');
const suggestBtn = document.getElementById('suggestBtn');
const inspectBtn = document.getElementById('inspectBtn');
const traceBtn = document.getElementById('traceBtn');
const resetBtn = document.getElementById('resetBtn');
const apiKeyInput = document.getElementById('apiKeyInput');
const agentAdapterUrlInput = document.getElementById('agentAdapterUrlInput');
const agentMaxStepsInput = document.getElementById('agentMaxStepsInput');
const promptResults = document.getElementById('promptResults');
const advancedSection = document.getElementById('advancedSection');
const globalToolsList = document.getElementById('globalToolsList');

// First, request list of tools from content script living in top-level frame.
(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, { action: 'LIST_TOOLS' }, { frameId: 0 });
  } catch (error) {
    const statusDiv = document.getElementById('status');
    statusDiv.textContent = error;
    statusDiv.hidden = false;
    copyToClipboard.hidden = true;
  }
})();

let currentTools;

// The in-flight agent run, bound to the tab it started on plus a snapshot of
// that tab's tools. The loop reads from here instead of the live `currentTools`
// so switching tabs (which repoints `currentTools` at the new active tab) can't
// corrupt a run. The listener below keeps `tools` fresh for the bound tab so an
// in-run navigation is still discovered. Declared before the listener so a
// LIST_TOOLS reply during startup can't read it in its temporal dead zone.
let activeRun = null;

// Listen for the results coming back from content.js
chrome.runtime.onMessage.addListener(async ({ message, tools, url, ready }, sender) => {
  if (sender.frameId && sender.frameId !== 0) return;

  // Keep the running agent's tool snapshot fresh for the tab it's bound to, even
  // when that tab isn't the active one, so an in-run navigation is still picked
  // up. Done before the active-tab gate below, which would otherwise drop it.
  if (tools && activeRun && sender.tab && sender.tab.id === activeRun.tabId) {
    activeRun.tools = tools;
    // Wake a turn waiting for the destination page to report its tools after a
    // navigation (see the post-tool-call wait in promptAI). `ready` is true only
    // for the EXPERIMENTAL webmcp:ready-driven push (see content.js), the
    // settled, full-tool-set snapshot; toolchange-driven pushes pass it falsy.
    activeRun.onToolsUpdate?.(ready);
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (sender.tab && sender.tab.id !== tab.id) return;

  tbody.innerHTML = '';
  thead.innerHTML = '';
  toolNames.innerHTML = '';

  statusDiv.textContent = message;
  statusDiv.hidden = !message;

  currentTools = tools;
  updateSuggestButton();

  if (!tools || tools.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = `<td colspan="100%"><i>No tools registered yet in ${url || tab.url}</i></td>`;
    tbody.appendChild(row);
    inputArgsText.value = '';
    inputArgsText.disabled = true;
    toolNames.disabled = true;
    executeBtn.disabled = true;
    copyToClipboard.hidden = true;
    return;
  }

  inputArgsText.disabled = false;
  toolNames.disabled = false;
  executeBtn.disabled = false;
  copyToClipboard.hidden = false;

  await loadHljs().catch(() => {});

  const KEYS = ['name', 'description', 'inputSchema', 'readOnlyHint', 'untrustedContentHint'];
  // Fixed widths for the predictable columns; inputSchema (left unset) absorbs
  // the remaining space.
  const COL_WIDTHS = {
    name: '14%',
    description: '28%',
    readOnlyHint: '9%',
    untrustedContentHint: '11%',
  };
  const keys = KEYS.filter((key) => tools.some((tool) => key in tool));
  keys.forEach((key) => {
    const th = document.createElement('th');
    th.textContent = key;
    if (COL_WIDTHS[key]) th.style.width = COL_WIDTHS[key];
    thead.appendChild(th);
  });

  tools.forEach((item) => {
    const row = document.createElement('tr');
    keys.forEach((key) => {
      const td = document.createElement('td');
      try {
        const json = JSON.stringify(JSON.parse(item[key]), null, '  ');
        td.innerHTML = `<pre class="json">${highlightJSON(json)}</pre>`;
      } catch (error) {
        td.textContent = item[key];
      }
      row.appendChild(td);
    });
    tbody.appendChild(row);

    const option = document.createElement('option');
    option.textContent = `"${item.name}"`;
    option.value = item.name;
    if (new Set(tools.map((t) => t.location)).size > 1) {
      option.textContent += ` | ${item.location || ''}`;
    }
    option.dataset.inputSchema = item.inputSchema || '{}';
    option.dataset.location = item.location || '';
    toolNames.appendChild(option);
  });
  updateDefaultValueForInputArgs();
});

tbody.ondblclick = () => {
  tbody.classList.toggle('prettify');
};

copyAsScriptToolConfig.onclick = async () => {
  const text = currentTools
    .map((tool) => {
      return `\
script_tools {
  name: "${tool.name}"
  description: "${tool.description}"
  input_schema: ${JSON.stringify(tool.inputSchema || { type: 'object', properties: {} })}
}`;
    })
    .join('\r\n');
  await navigator.clipboard.writeText(text);
};

copyAsJSON.onclick = async () => {
  const tools = currentTools.map((tool) => {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
        ? JSON.parse(tool.inputSchema)
        : { type: 'object', properties: {} },
    };
  });
  await navigator.clipboard.writeText(JSON.stringify(tools, '', '  '));
};

// Interact with the page

let genAI, chat;

const envModulePromise = import('./.env.json', { with: { type: 'json' } });

// Which key + model the active provider uses.
function isArk() {
  return localStorage.provider === 'ark';
}

function isDeepSeek() {
  return localStorage.provider === 'deepseek';
}

function currentModel() {
  if (isArk()) return localStorage.arkModel;
  if (isDeepSeek()) return localStorage.deepseekModel;
  return localStorage.model;
}

const AGENT_ARCHITECTURES = {
  base: {
    label: 'Base',
    mode: 'base',
  },
  weboperator: {
    label: 'WebOperator',
    mode: 'browser',
  },
  opagent: {
    label: 'OpAgent',
    mode: 'browser',
  },
};

function currentAgentArchitecture() {
  return AGENT_ARCHITECTURES[localStorage.agentArchitecture]
    ? localStorage.agentArchitecture
    : 'base';
}

function currentAgent() {
  return AGENT_ARCHITECTURES[currentAgentArchitecture()];
}

function isAdapterAgent() {
  return currentAgent().mode === 'adapter';
}

function isBrowserAgent() {
  return currentAgent().mode === 'browser';
}

function currentAdapterBaseUrl() {
  return (localStorage.agentAdapterUrl || '').replace(/\/+$/, '');
}

function currentAgentMaxSteps() {
  const maxSteps = Number.parseInt(localStorage.agentMaxSteps || '30', 10);
  return Number.isFinite(maxSteps) && maxSteps > 0 ? maxSteps : 30;
}

// Built-in (page-independent) tools are opt-in per tool. The enabled set is a
// JSON name->bool map in localStorage; an absent or unparseable value means all
// off. Old single-flag values (e.g. 'on') simply fall back to nothing enabled.
function enabledGlobalTools() {
  try {
    const map = JSON.parse(localStorage.globalTools || '{}');
    return map && typeof map === 'object' ? map : {};
  } catch {
    return {};
  }
}

function isGlobalToolEnabled(name) {
  return enabledGlobalTools()[name] === true;
}

function setGlobalToolEnabled(name, on) {
  const map = enabledGlobalTools();
  map[name] = on;
  localStorage.globalTools = JSON.stringify(map);
}

async function initProvider() {
  let env;
  try {
    // Try load .env.json if present.
    env = (await envModulePromise).default;
  } catch {}

  localStorage.provider ??= env?.provider || 'ark';
  localStorage.agentArchitecture ??= env?.agentArchitecture || 'base';
  localStorage.agentAdapterUrl ??= env?.agentAdapterUrl || '';
  localStorage.agentMaxSteps ??= String(env?.agentMaxSteps || 30);

  // Gemini key + model migrations.
  if (env?.apiKey) localStorage.apiKey ??= env.apiKey;
  if (localStorage.model === 'gemini-2.5-flash') {
    localStorage.model = 'gemini-3-flash-preview';
  }
  if (localStorage.model === 'gemini-3.1-flash-lite-preview') {
    localStorage.model = 'gemini-3.1-flash-lite';
  }
  localStorage.model ??= env?.model || 'gemini-3-flash-preview';

  // ARK key + model + thinking config.
  if (env?.arkApiKey) localStorage.arkApiKey ??= env.arkApiKey;
  if (env?.arkBaseUrl) localStorage.arkBaseUrl ??= env.arkBaseUrl;
  // Early ARK slugs shipped without their required date suffix (and `code` was
  // really `code-preview`), so they 404 on ARK. Heal any such stored selection.
  // The flash family was removed (not accessible / unverifiable); both its bare
  // and dated slugs fall back to the default model.
  const ARK_SLUG_MIGRATIONS = {
    'doubao-seed-2-0-mini': 'doubao-seed-2-0-mini-260428',
    'doubao-seed-2-0-code': 'doubao-seed-2-0-code-preview-260215',
    'doubao-seed-1-8': 'doubao-seed-1-8-251228',
    'doubao-seed-1-6-flash': 'doubao-seed-2-0-lite-260428',
    'doubao-seed-1-6-flash-250828': 'doubao-seed-2-0-lite-260428',
    'doubao-seed-1-6-vision': 'doubao-seed-1-6-vision-250815',
  };
  if (ARK_SLUG_MIGRATIONS[localStorage.arkModel]) {
    localStorage.arkModel = ARK_SLUG_MIGRATIONS[localStorage.arkModel];
  }
  localStorage.arkModel ??= env?.arkModel || 'doubao-seed-2-0-lite-260428';
  localStorage.arkThinking ??= env?.arkThinking || 'disabled';

  // DeepSeek key + model + thinking config.
  if (env?.deepseekApiKey) localStorage.deepseekApiKey ??= env.deepseekApiKey;
  if (env?.deepseekBaseUrl) localStorage.deepseekBaseUrl ??= env.deepseekBaseUrl;
  localStorage.deepseekModel ??= env?.deepseekModel || 'deepseek-v4-flash';
  localStorage.deepseekThinking ??= env?.deepseekThinking || 'disabled';

  await refreshClient();
  updateApiKeyField();
  syncAdvancedUI();
}

function canRunAgent() {
  if (isAdapterAgent()) return !!currentAdapterBaseUrl();
  return !!genAI;
}

function updateRunButtons() {
  promptBtn.disabled = !canRunAgent();
  resetBtn.disabled = !canRunAgent();
}

// (Re)build the active provider's client and gate the Send/Reset buttons on it.
async function refreshClient() {
  if (isArk()) {
    genAI = localStorage.arkApiKey
      ? new ArkAI({
          apiKey: localStorage.arkApiKey,
          baseURL: localStorage.arkBaseUrl,
          thinkingMode: localStorage.arkThinking,
        })
      : undefined;
  } else if (isDeepSeek()) {
    genAI = localStorage.deepseekApiKey
      ? new DeepSeekAI({
          apiKey: localStorage.deepseekApiKey,
          baseURL: localStorage.deepseekBaseUrl,
          thinkingMode: localStorage.deepseekThinking,
        })
      : undefined;
  } else if (localStorage.apiKey) {
    try {
      const GenAI = await loadGoogleGenAI();
      genAI = new GenAI({ apiKey: localStorage.apiKey });
    } catch (error) {
      genAI = undefined;
      logLine('error', 'Gemini SDK not bundled', `Run "npm install", or use the ARK provider. (${error})`);
    }
  } else {
    genAI = undefined;
  }
  chat = undefined;
  updateRunButtons();
  updateSuggestButton();
}

function updateApiKeyField() {
  if (isArk()) {
    apiKeyInput.placeholder = 'ARK API key';
    apiKeyInput.value = localStorage.arkApiKey || '';
  } else if (isDeepSeek()) {
    apiKeyInput.placeholder = 'DeepSeek API key';
    apiKeyInput.value = localStorage.deepseekApiKey || '';
  } else {
    apiKeyInput.placeholder = 'Gemini API key';
    apiKeyInput.value = localStorage.apiKey || '';
  }
}

// Restore stored selections into the radios. Which group is visible is handled
// entirely in CSS via :has() on the checked provider radio.
function setRadio(name, value) {
  document.querySelectorAll(`input[name="${name}"]`).forEach((radio) => {
    radio.checked = radio.value === value;
  });
}

function syncAdvancedUI() {
  setRadio('agentArchitecture', currentAgentArchitecture());
  setRadio('provider', localStorage.provider);
  setRadio('geminiModel', localStorage.model);
  setRadio('arkModel', localStorage.arkModel);
  setRadio('arkThinking', localStorage.arkThinking);
  setRadio('deepseekModel', localStorage.deepseekModel);
  setRadio('deepseekThinking', localStorage.deepseekThinking);
  if (agentAdapterUrlInput) agentAdapterUrlInput.value = localStorage.agentAdapterUrl || '';
  agentMaxStepsInput.value = String(currentAgentMaxSteps());
}

await initProvider();

document.querySelectorAll('input[name="agentArchitecture"]').forEach((radio) => {
  radio.onchange = () => {
    localStorage.agentArchitecture = radio.value;
    chat = undefined;
    updateRunButtons();
    updateSuggestButton();
  };
});

document.querySelectorAll('input[name="provider"]').forEach((radio) => {
  radio.onchange = async () => {
    localStorage.provider = radio.value;
    await initProvider();
  };
});

document.querySelectorAll('input[name="geminiModel"]').forEach((radio) => {
  radio.onclick = () => {
    localStorage.model = radio.value;
    chat = undefined;
    advancedSection.hidePopover();
  };
});

document.querySelectorAll('input[name="arkModel"]').forEach((radio) => {
  radio.onclick = () => {
    localStorage.arkModel = radio.value;
    chat = undefined;
    advancedSection.hidePopover();
  };
});

document.querySelectorAll('input[name="arkThinking"]').forEach((radio) => {
  radio.onclick = async () => {
    localStorage.arkThinking = radio.value;
    await initProvider();
  };
});

document.querySelectorAll('input[name="deepseekModel"]').forEach((radio) => {
  radio.onclick = () => {
    localStorage.deepseekModel = radio.value;
    chat = undefined;
    advancedSection.hidePopover();
  };
});

document.querySelectorAll('input[name="deepseekThinking"]').forEach((radio) => {
  radio.onclick = async () => {
    localStorage.deepseekThinking = radio.value;
    await initProvider();
  };
});

if (agentAdapterUrlInput) {
  agentAdapterUrlInput.oninput = () => {
    localStorage.agentAdapterUrl = agentAdapterUrlInput.value.trim();
    updateRunButtons();
  };
}

agentMaxStepsInput.oninput = () => {
  const maxSteps = Number.parseInt(agentMaxStepsInput.value, 10);
  if (Number.isFinite(maxSteps) && maxSteps > 0) {
    localStorage.agentMaxSteps = String(maxSteps);
  }
};

// The Suggest button is usable once a client and tools are both available.
function updateSuggestButton() {
  suggestBtn.disabled = currentAgentArchitecture() !== 'base' || !genAI || !currentTools || currentTools.length === 0;
}

suggestBtn.onclick = async () => {
  if (suggestBtn.disabled) return;
  suggestBtn.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // Give the model a clean view of the tools: parse inputSchema out of its
    // stored string form and drop transport noise (location), so it reasons over
    // real JSON Schema rather than a stringified blob.
    const toolSummary = currentTools.map((t) => ({
      name: t.name,
      description: t.description,
      readOnly: !!t.readOnlyHint,
      inputSchema: t.inputSchema ? JSON.parse(t.inputSchema) : { type: 'object', properties: {} },
    }));
    const response = await genAI.models.generateContent({
      model: currentModel(),
      contents: [
        'You generate ONE realistic user request used to test a browser agent against the tools a web page currently exposes.',
        '',
        'Guidelines:',
        '- Ground the request in what these specific tools actually do and in the page the user is on; never assume capabilities the tools do not provide.',
        '- Prefer a request that naturally chains several of the tools together; fall back to a single tool when that is all the set supports.',
        '- Supply concrete, plausible values for required inputs (real-sounding search terms, names, topics), never placeholders like "example" or "string".',
        "- Mention a date or time only if a tool actually takes one. When it does, choose a date that fits that tool's purpose relative to today: past dates for searching or filtering existing content, future dates for booking or scheduling.",
        "- Phrase it the way a real user of this site would, including the site's own language when that is what its users would use.",
        '- Output the request text only: no surrounding quotes, no markdown, no explanation.',
        '',
        `Today's date is: ${getFormattedDate()}.`,
        `Current page: ${tab?.title || '(untitled)'} - ${tab?.url || 'unknown'}`,
        '',
        'Tools available on this page:',
        JSON.stringify(toolSummary, null, 2),
      ],
    });
    userPromptText.value = response.text?.trim() || '';
  } catch (error) {
    logLine('error', 'Error suggesting prompt', String(error));
  } finally {
    updateSuggestButton();
  }
};

userPromptText.onkeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    promptBtn.click();
  }
};

promptBtn.onclick = async () => {
  try {
    await promptAI();
  } catch (error) {
    trace.push({ error });
    logLine('error', 'Error', String(error));
  }
};

let trace = [];

// Incremented on every Send and on Reset. A running loop captures the value at
// start and bails the moment it no longer matches, so Reset stops the run.
let activeRunId = 0;

async function promptAI() {
  const myRun = ++activeRunId;
  const stopped = () => myRun !== activeRunId;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (stopped()) return;

  const run = (activeRun = { id: myRun, tabId: tab.id, tools: currentTools || [] });

  const message = userPromptText.value;
  userPromptText.value = '';
  logLine('user', 'User', message);

  const architecture = currentAgentArchitecture();
  if (architecture !== 'base') {
    const runtime = new BrowserRuntime({ tab, run, stopped });
    if (isAdapterAgent()) {
      await promptAdapterAgent({ architecture, runtime, message, stopped });
    } else {
      await promptBrowserAgent({ architecture, runtime, message, stopped });
    }
    return;
  }

  chat ??= genAI.chats.create({ model: currentModel() });

  const sendMessageParams = { message, config: getConfig(run.tools) };
  trace.push({ userPrompt: sendMessageParams });
  let currentResult = await chat.sendMessage(sendMessageParams);
  if (stopped()) return;
  let finalResponseGiven = false;

  while (!finalResponseGiven) {
    const response = currentResult;
    trace.push({ response });
    const functionCalls = response.functionCalls || [];

    if (functionCalls.length === 0) {
      if (!response.text) {
        logJSON('error', 'Agent response has no text', JSON.stringify(response.candidates));
      } else {
        logLine('agent', 'Agent', response.text.trim());
      }
      finalResponseGiven = true;
    } else {
      // Armed before the batch so a load that starts during a tool call is seen.
      const nav = watchNavigation(run);
      const toolResponses = [];
      for (const { name: toolName, args } of functionCalls) {
        if (stopped()) return;
        const inputArgs = JSON.stringify(args);

        const globalTool = GLOBAL_TOOLS[toolName];
        if (globalTool) {
          logJSON('toolcall', `Tool call → ${toolName}`, inputArgs);
          try {
            const result = await globalTool.execute(tab.id, args);
            if (stopped()) return;
            toolResponses.push({ functionResponse: { name: toolName, response: { result } } });
            logJSON('toolresult', `Tool result → ${toolName}`, result, { open: false });
          } catch (e) {
            if (stopped()) return;
            logLine('error', `Tool error → ${toolName}`, e.message);
            toolResponses.push({
              functionResponse: { name: toolName, response: { error: e.message } },
            });
          }
          continue;
        }

        const [locationIndex, name] = toolName.split(/_(.*)/s)[1].split(/_(.*)/s);
        const location = run.tools[locationIndex].location;
        logJSON('toolcall', `Tool call → ${name}`, inputArgs);
        try {
          const result = await executeTool(tab.id, name, inputArgs, location);
          if (stopped()) return;
          toolResponses.push({ functionResponse: { name: toolName, response: { result } } });
          logJSON('toolresult', `Tool result → ${name}`, result, { open: false });
        } catch (e) {
          if (stopped()) return;
          logLine('error', `Tool error → ${name}`, e.message);
          toolResponses.push({
            functionResponse: { name: toolName, response: { error: e.message } },
          });
        }
      }

      // If a tool navigated the bound tab, wait for the new page (and its tools)
      // to settle so the next turn sees that page's tool list, not the old one.
      await nav.settle();
      if (stopped()) return;

      const sendMessageParams = { message: toolResponses, config: getConfig(run.tools) };
      trace.push({ userPrompt: sendMessageParams });
      currentResult = await chat.sendMessage(sendMessageParams);
      if (stopped()) return;
    }
  }
}

const BROWSER_ACTIONS = [
  {
    type: 'click',
    description: 'Click an element by bid, CSS selector, or screenshot coordinates.',
    schema: { bid: 'string?', selector: 'string?', x: 'number?', y: 'number?' },
  },
  {
    type: 'fill',
    description: 'Fill an input, textarea, or editable element by bid, selector, or coordinates.',
    schema: { bid: 'string?', selector: 'string?', x: 'number?', y: 'number?', value: 'string', pressEnter: 'boolean?' },
  },
  {
    type: 'type',
    description: 'Alias for fill.',
    schema: { bid: 'string?', selector: 'string?', x: 'number?', y: 'number?', text: 'string', pressEnter: 'boolean?' },
  },
  {
    type: 'select_option',
    description: 'Select an option in a select element.',
    schema: { bid: 'string?', selector: 'string?', option: 'string' },
  },
  {
    type: 'scroll',
    description: 'Scroll the page vertically or horizontally.',
    schema: { direction: 'up|down|left|right', distance: 'number?' },
  },
  { type: 'goto', description: 'Navigate the current tab to a URL.', schema: { url: 'string' } },
  { type: 'go_back', description: 'Navigate back.', schema: {} },
  { type: 'go_forward', description: 'Navigate forward.', schema: {} },
  { type: 'wait', description: 'Wait for a number of seconds.', schema: { seconds: 'number' } },
  {
    type: 'webmcp_call',
    description: 'Call a WebMCP tool by name with JSON arguments.',
    schema: { tool: 'string', params: 'object|string?' },
  },
  {
    type: 'webmcp_tool',
    description: 'OpAgent alias for webmcp_call.',
    schema: { tool_name: 'string', tool_args: 'object|string?' },
  },
  { type: 'answer', description: 'Finish with a final answer.', schema: { content: 'string' } },
  { type: 'stop', description: 'Finish with a final answer.', schema: { text: 'string' } },
];

class BrowserRuntime {
  constructor({ tab, run, stopped }) {
    this.tab = tab;
    this.run = run;
    this.stopped = stopped;
  }

  async inspect({ includeScreenshot = false } = {}) {
    const tab = await chrome.tabs.get(this.tab.id);
    const snapshot = await this.getDomSnapshot();
    const screenshot = includeScreenshot ? await this.captureScreenshot(tab).catch((error) => ({ error: String(error) })) : null;
    return {
      tab: {
        id: tab.id,
        title: tab.title,
        url: tab.url,
        status: tab.status,
      },
      date: getFormattedDate(),
      architecture: currentAgentArchitecture(),
      actions: BROWSER_ACTIONS,
      webmcpTools: normalizeToolsForAdapter(this.run.tools || []),
      dom: snapshot,
      screenshot,
    };
  }

  async captureScreenshot(tab) {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return { dataUrl };
  }

  async getDomSnapshot() {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: this.tab.id, frameIds: [0] },
      func: collectPageSnapshot,
    });
    return result;
  }

  async executeAction(action) {
    const normalized = normalizeAction(action);
    if (!normalized?.type) throw new Error(`Invalid action: ${JSON.stringify(action)}`);

    if (normalized.type === 'answer' || normalized.type === 'stop') {
      return {
        ok: true,
        terminal: true,
        message: normalized.args.content || normalized.args.text || 'Done.',
      };
    }

    if (normalized.type === 'webmcp_call' || normalized.type === 'webmcp_tool') {
      return await this.executeWebMcpAction(normalized);
    }

    const nav = watchNavigation(this.run);
    let result;
    try {
      if (normalized.type === 'goto') {
        await chrome.tabs.update(this.tab.id, { url: normalized.args.url });
        await waitForPageLoad(this.tab.id);
        result = { ok: true, url: normalized.args.url };
      } else if (normalized.type === 'go_back') {
        await chrome.tabs.goBack(this.tab.id);
        await waitForPageLoad(this.tab.id);
        result = { ok: true };
      } else if (normalized.type === 'go_forward') {
        await chrome.tabs.goForward(this.tab.id);
        await waitForPageLoad(this.tab.id);
        result = { ok: true };
      } else if (normalized.type === 'wait') {
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(normalized.args.seconds || 1)) * 1000));
        result = { ok: true };
      } else {
        const [{ result: pageResult }] = await chrome.scripting.executeScript({
          target: { tabId: this.tab.id, frameIds: [0] },
          func: executePageAction,
          args: [normalized],
        });
        result = pageResult;
      }
      await nav.settle();
      return result;
    } finally {
      if (this.stopped()) return { ok: false, stopped: true };
    }
  }

  async executeWebMcpAction(action) {
    const args = action.args || {};
    const toolName = args.tool || args.tool_name || args.name;
    let params = args.params ?? args.tool_args ?? args.arguments ?? {};
    if (params == null) params = {};
    const inputArgs = typeof params === 'string' ? params : JSON.stringify(params);
    const tool = (this.run.tools || []).find((item) => item.name === toolName);
    if (!tool) {
      throw new Error(`WebMCP tool "${toolName}" is not available on this page.`);
    }
    const nav = watchNavigation(this.run);
    try {
      const result = await executeTool(this.tab.id, toolName, inputArgs, tool.location || '');
      await nav.settle();
      return { ok: true, result };
    } finally {
      if (this.stopped()) return { ok: false, stopped: true };
    }
  }
}

function collectPageSnapshot() {
  const interactiveSelector = [
    'a[href]',
    'button',
    'input',
    'textarea',
    'select',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[contenteditable="true"]',
    '[onclick]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  const elements = Array.from(document.querySelectorAll(interactiveSelector)).slice(0, 250);
  const interactive = elements.map((el, index) => {
    const bid = String(index);
    el.setAttribute('data-mcti-bid', bid);
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const label = [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.innerText,
      el.value,
      el.placeholder,
      el.name,
      el.id,
    ].find((value) => value && String(value).trim());
    return {
      bid,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      type: el.getAttribute('type') || '',
      text: String(label || '').replace(/\s+/g, ' ').trim().slice(0, 180),
      href: el.href || '',
      selector: selectorForElement(el),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
    };
  });

  return {
    title: document.title,
    url: location.href,
    viewport: { width: innerWidth, height: innerHeight },
    scroll: { x: scrollX, y: scrollY },
    text: document.body?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 6000) || '',
    interactive,
  };

  function selectorForElement(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const bid = el.getAttribute('data-mcti-bid');
    if (bid) return `[data-mcti-bid="${CSS.escape(bid)}"]`;
    return el.tagName.toLowerCase();
  }
}

function executePageAction(action) {
  const { type, args = {} } = action;
  const element = resolveTarget(args);
  if (type === 'click') {
    if (!element) return { ok: false, error: 'No click target found.' };
    element.click();
    return { ok: true };
  }
  if (type === 'fill' || type === 'type') {
    if (!element) return { ok: false, error: 'No fill target found.' };
    const value = args.value ?? args.text ?? args.content ?? '';
    element.focus();
    if ('value' in element) {
      element.value = value;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      element.textContent = value;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    }
    if (args.pressEnter || args.press_enter || args.press_enter_after) {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    }
    return { ok: true };
  }
  if (type === 'select_option') {
    if (!element) return { ok: false, error: 'No select target found.' };
    const option = args.option ?? args.value ?? '';
    element.value = option;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }
  if (type === 'scroll') {
    const distance = Number(args.distance ?? args.pixel_amount ?? 500);
    const direction = args.direction || 'down';
    const dx = direction === 'left' ? -distance : direction === 'right' ? distance : 0;
    const dy = direction === 'up' ? -distance : direction === 'down' ? distance : 0;
    scrollBy(dx, dy);
    return { ok: true, scroll: { x: scrollX, y: scrollY } };
  }
  return { ok: false, error: `Unsupported page action "${type}".` };

  function resolveTarget(rawArgs) {
    if (rawArgs.bid != null) return document.querySelector(`[data-mcti-bid="${CSS.escape(String(rawArgs.bid))}"]`);
    if (rawArgs.selector) return document.querySelector(rawArgs.selector);
    const coords = rawArgs.coords || rawArgs.coordinate || null;
    const x = rawArgs.x ?? rawArgs.coordinate_x ?? coords?.[0];
    const y = rawArgs.y ?? rawArgs.coordinate_y ?? coords?.[1];
    if (x != null && y != null) return document.elementFromPoint(Number(x), Number(y));
    return null;
  }
}

async function promptBrowserAgent({ architecture, runtime, message, stopped }) {
  const agent = AGENT_ARCHITECTURES[architecture];
  const browserChat = genAI.chats.create({ model: currentModel() });
  const config = getBrowserAgentConfig(architecture);
  const history = [];
  logLine('note', agent.label, `Using built-in ${agent.label} browser agent`);

  for (let step = 1; step <= currentAgentMaxSteps(); step++) {
    if (stopped()) return;
    const observation = await runtime.inspect({ includeScreenshot: false });
    const userMessage = buildBrowserAgentMessage({ architecture, message, observation, history, step });
    trace.push({ browserAgentPrompt: { architecture, step, message: userMessage } });

    let currentResult = await browserChat.sendMessage({ message: userMessage, config });
    if (stopped()) return;

    while (true) {
      trace.push({ browserAgentResponse: currentResult });
      const functionCalls = currentResult.functionCalls || [];
      if (!functionCalls.length) {
        const text = currentResult.text?.trim();
        if (text) logLine('agent', agent.label, text);
        return;
      }

      const toolResponses = [];
      for (const { name, args } of functionCalls) {
        if (stopped()) return;
        const action = { type: name, args: args || {} };
        logJSON('toolcall', `${agent.label} action -> ${name}`, JSON.stringify(action));
        const result = await runtime.executeAction(action);
        history.push({ step, action, result });
        trace.push({ browserAgentAction: action, browserAgentActionResult: result });
        logJSON('toolresult', `${agent.label} result -> ${name}`, JSON.stringify(result), { open: false });
        toolResponses.push({ functionResponse: { name, response: result } });
        if (result.terminal) {
          if (result.message) logLine('agent', agent.label, result.message);
          return;
        }
      }

      currentResult = await browserChat.sendMessage({ message: toolResponses, config });
      if (stopped()) return;
    }
  }

  logLine('error', agent.label, `Stopped after ${currentAgentMaxSteps()} steps.`);
}

function getBrowserAgentConfig(architecture) {
  return {
    systemInstruction: getBrowserAgentSystemInstruction(architecture),
    tools: [{ functionDeclarations: getBrowserActionDeclarations() }],
  };
}

function getBrowserAgentSystemInstruction(architecture) {
  const label = AGENT_ARCHITECTURES[architecture]?.label || 'Browser Agent';
  const style = architecture === 'opagent'
    ? 'Use an operation-agent style: maintain a short goal, choose precise actions, and verify after each page change.'
    : 'Use a WebOperator style: observe the page, choose browser actions, and use WebMCP tools when they are the most direct path.';
  return [
    `You are ${label}, an agent controlling the active browser tab.`,
    style,
    'Use only the provided browser action functions.',
    'Prefer WebMCP tool calls when the observation lists relevant WebMCP tools.',
    'Use click, fill, select_option, scroll, goto, go_back, go_forward, and wait to operate normal page UI.',
    'Call answer or stop when the user request is complete.',
    `Today's date is: ${getFormattedDate()}.`,
  ];
}

function buildBrowserAgentMessage({ architecture, message, observation, history, step }) {
  return [
    `Architecture: ${AGENT_ARCHITECTURES[architecture]?.label || architecture}`,
    `User request: ${message}`,
    `Step: ${step} of ${currentAgentMaxSteps()}`,
    `Recent action results: ${JSON.stringify(history.slice(-6), null, 2)}`,
    `Current browser observation: ${JSON.stringify(observation, null, 2)}`,
  ].join('\n\n');
}

function getBrowserActionDeclarations() {
  return BROWSER_ACTIONS.map((action) => ({
    name: action.type,
    description: action.description,
    parametersJsonSchema: simpleActionSchemaToJsonSchema(action.schema || {}),
  }));
}

function simpleActionSchemaToJsonSchema(schema) {
  const properties = {};
  const required = [];
  for (const [name, typeSpec] of Object.entries(schema)) {
    const raw = String(typeSpec);
    const optional = raw.endsWith('?');
    const clean = optional ? raw.slice(0, -1) : raw;
    properties[name] = simpleTypeToJsonSchema(clean);
    if (!optional) required.push(name);
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
  };
}

function simpleTypeToJsonSchema(typeSpec) {
  if (typeSpec.includes('|')) {
    const parts = typeSpec.split('|').map((part) => part.trim()).filter(Boolean);
    const primitiveTypes = new Set(['string', 'number', 'boolean', 'object']);
    if (parts.every((part) => primitiveTypes.has(part))) {
      return { anyOf: parts.map((part) => ({ type: part })) };
    }
    return { type: 'string', enum: parts };
  }
  if (typeSpec === 'number') return { type: 'number' };
  if (typeSpec === 'boolean') return { type: 'boolean' };
  if (typeSpec === 'object') return { type: 'object', additionalProperties: true };
  return { type: 'string' };
}

async function promptAdapterAgent({ architecture, runtime, message, stopped }) {
  const agent = AGENT_ARCHITECTURES[architecture];
  const adapterUrl = `${currentAdapterBaseUrl()}${agent.endpoint}`;
  const runId = `${architecture}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const history = [];
  if (!currentAdapterBaseUrl()) {
    throw new Error(`${agent.label} requires an Agent Adapter URL. Set it to a running adapter server before sending.`);
  }
  logLine('note', agent.label, `Using adapter ${adapterUrl}`);

  for (let step = 1; step <= currentAgentMaxSteps(); step++) {
    if (stopped()) return;
    const observation = await runtime.inspect({ includeScreenshot: true });
    const request = {
      architecture,
      runId,
      step,
      maxSteps: currentAgentMaxSteps(),
      prompt: message,
      observation,
      history,
      actionSchema: BROWSER_ACTIONS,
    };
    trace.push({ adapterRequest: request });

    let response;
    try {
      response = await fetch(adapterUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
    } catch (error) {
      throw new Error(formatAdapterConnectionError(agent, adapterUrl, error));
    }
    if (!response.ok) {
      throw new Error(`${agent.label} adapter ${response.status}: ${await response.text()}`);
    }

    const payload = await response.json();
    trace.push({ adapterResponse: payload });
    if (payload.message || payload.thought) {
      logLine('agent', agent.label, payload.message || payload.thought);
    }
    if (payload.done || payload.finalAnswer) {
      logLine('agent', agent.label, payload.finalAnswer || payload.message || 'Done.');
      return;
    }

    const actions = normalizeAdapterActions(payload);
    if (!actions.length) {
      logJSON('error', `${agent.label} returned no action`, JSON.stringify(payload));
      return;
    }

    for (const action of actions) {
      if (stopped()) return;
      logJSON('toolcall', `${agent.label} action -> ${action.type}`, JSON.stringify(action));
      const result = await runtime.executeAction(action);
      history.push({ step, action, result });
      trace.push({ adapterAction: action, adapterActionResult: result });
      logJSON('toolresult', `${agent.label} result -> ${action.type}`, JSON.stringify(result), { open: false });
      if (result.terminal) {
        if (result.message) logLine('agent', agent.label, result.message);
        return;
      }
    }
  }

  logLine('error', agent.label, `Stopped after ${currentAgentMaxSteps()} steps.`);
}

function formatAdapterConnectionError(agent, adapterUrl, error) {
  const detail = error?.message ? ` (${error.message})` : '';
  return `${agent.label} adapter is not reachable at ${adapterUrl}${detail}. Start a compatible agent adapter server or set Agent Adapter URL to one that is running.`;
}

function normalizeToolsForAdapter(tools) {
  return (tools || []).map((tool) => ({
    name: tool.name,
    description: tool.description || '',
    inputSchema: tool.inputSchema ? safeParseJSON(tool.inputSchema, {}) : {},
    readOnly: tool.readOnlyHint === '\u2713' || tool.readOnlyHint === true,
    untrustedContent: tool.untrustedContentHint === '\u2713' || tool.untrustedContentHint === true,
    location: tool.location || '',
  }));
}

function normalizeAdapterActions(payload) {
  const raw = payload.actions || payload.action || payload.tool_call || payload.toolCall;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map(normalizeAction).filter(Boolean);
}

function normalizeAction(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return parseActionString(raw);
  if (raw.function?.name) {
    return normalizeAction({
      name: raw.function.name,
      args: typeof raw.function.arguments === 'string'
        ? safeParseJSON(raw.function.arguments, { value: raw.function.arguments })
        : raw.function.arguments,
    });
  }
  const type = raw.type || raw.action_type || raw.name;
  const rawArgs = raw.args || raw.arguments || raw.params || raw;
  const parsedArgs = typeof rawArgs === 'string' ? safeParseJSON(rawArgs, { value: rawArgs }) : rawArgs;
  const args = parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs)
    ? { ...parsedArgs }
    : { value: parsedArgs };
  delete args.type;
  delete args.action_type;
  delete args.name;
  if (!type) return null;
  return { type, args };
}

function parseActionString(raw) {
  const text = raw.trim();
  const match = text.match(/^([a-zA-Z_]\w*)\(([\s\S]*)\)$/);
  if (!match) return null;
  const [, type, body] = match;
  if (type === 'go_back' || type === 'go_forward') return { type, args: {} };
  if (type === 'scroll') return { type, args: { direction: firstQuotedValue(body) || 'down' } };
  if (type === 'goto') return { type, args: { url: firstQuotedValue(body) || body.trim() } };
  if (type === 'stop') return { type, args: { text: firstQuotedValue(body) || body.trim() } };
  if (type === 'click') return { type, args: { bid: firstQuotedValue(body) || body.trim() } };
  if (type === 'fill') {
    const values = quotedValues(body);
    return { type, args: { bid: values[0], value: values[1] || '' } };
  }
  if (type === 'webmcp_call') {
    const values = quotedValues(body);
    return { type, args: { tool: values[0], params: safeParseJSON(values[1] || '{}', values[1] || '{}') } };
  }
  return { type, args: { raw: body } };
}

function quotedValues(text) {
  const values = [];
  const pattern = /(['"])((?:\\.|(?!\1).)*)\1/g;
  let match;
  while ((match = pattern.exec(text))) values.push(match[2].replace(/\\(['"])/g, '$1'));
  return values;
}

function firstQuotedValue(text) {
  return quotedValues(text)[0];
}

function safeParseJSON(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

resetBtn.onclick = () => {
  activeRunId++;
  activeRun = null;
  chat = undefined;
  trace = [];
  userPromptText.value = '';
  promptResults.textContent = '';
};

inspectBtn.onclick = async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const run = activeRun || { id: activeRunId, tabId: tab.id, tools: currentTools || [] };
    const runtime = new BrowserRuntime({ tab, run, stopped: () => false });
    const observation = await runtime.inspect({ includeScreenshot: false });
    trace.push({ inspection: observation });
    logJSON('note', 'Inspection snapshot', JSON.stringify(observation));
  } catch (error) {
    logLine('error', 'Inspect error', String(error));
  }
};

// Save live so the Send button enables as soon as a key is present; rebuild the
// client directly rather than via initProvider so the input cursor isn't reset.
apiKeyInput.oninput = async () => {
  const apiKey = apiKeyInput.value.trim();
  if (isArk()) localStorage.arkApiKey = apiKey;
  else if (isDeepSeek()) localStorage.deepseekApiKey = apiKey;
  else localStorage.apiKey = apiKey;
  await refreshClient();
};

traceBtn.onclick = async () => {
  const text = JSON.stringify(trace, '', ' ');
  await navigator.clipboard.writeText(text);
  const original = traceBtn.textContent;
  traceBtn.textContent = 'Copied!';
  traceBtn.classList.add('copied');
  setTimeout(() => {
    traceBtn.textContent = original;
    traceBtn.classList.remove('copied');
  }, 1200);
};

executeBtn.onclick = async () => {
  toolResults.textContent = '';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const name = toolNames.selectedOptions[0].value;
  const inputArgs = inputArgsText.value;
  const location = toolNames.selectedOptions[0].dataset.location;
  const result = await executeTool(tab.id, name, inputArgs, location).catch(
    (error) => `⚠️ Error: "${error}"`,
  );
  let pretty = result;
  try {
    pretty = JSON.stringify(JSON.parse(result), null, '  ');
  } catch {}
  toolResults.className = 'json';
  toolResults.innerHTML = highlightJSON(pretty);
};

async function executeTool(tabId, name, inputArgs, location) {
  try {
    const result = await chrome.tabs.sendMessage(tabId, {
      action: 'EXECUTE_TOOL',
      name,
      inputArgs,
      location,
    });
    if (result !== null) return result;
  } catch (error) {
    if (!error.message.includes('message channel is closed')) throw error;
  }
  // A navigation was triggered. The result will be on the next document.
  // TODO: Handle case where a new tab is opened.
  await waitForPageLoad(tabId);
  return await chrome.tabs.sendMessage(tabId, {
    action: 'GET_CROSS_DOCUMENT_SCRIPT_TOOL_RESULT',
    location,
  });
}

toolNames.onchange = updateDefaultValueForInputArgs;

function updateDefaultValueForInputArgs() {
  const inputSchema = toolNames.selectedOptions[0].dataset.inputSchema || '{}';
  const template = generateTemplateFromSchema(JSON.parse(inputSchema));
  inputArgsText.value = JSON.stringify(template, '', ' ');
}

// Utils

// highlight.js (core + json grammar) is bundled to hljs.js by `npm install`.
// Returns editor-colored HTML, falling back to escaped plain text when the
// bundle is absent.
function highlightJSON(json) {
  // A tool that triggers a navigation can resolve with no value (the result
  // lives on the next document), so callers may pass undefined here. Coerce to
  // a string first; otherwise `.replace` / hljs.highlight throw "Cannot read
  // properties of undefined (reading 'replace')", which the agent loop then
  // reports as a spurious tool error for what was actually a successful nav.
  const text = json == null ? '' : String(json);
  if (hljs) return hljs.highlight(text, { language: 'json' }).value;
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function appendLog(node) {
  promptResults.appendChild(node);
  promptResults.scrollTop = promptResults.scrollHeight;
}

// A plain text log entry tagged with a role (user/agent/tool/error/note).
function logLine(kind, label, text) {
  const entry = document.createElement('div');
  entry.className = `log-entry log-${kind}`;
  if (label) {
    const tag = document.createElement('div');
    tag.className = 'log-label';
    tag.textContent = label;
    entry.appendChild(tag);
  }
  if (text) {
    const body = document.createElement('div');
    body.className = 'log-body';
    body.textContent = text;
    entry.appendChild(body);
  }
  appendLog(entry);
}

// A collapsible entry whose body is pretty-printed, syntax-highlighted JSON
// (falls back to raw text when the payload isn't JSON).
function logJSON(kind, label, raw, { open = true } = {}) {
  const entry = document.createElement('details');
  entry.className = `log-entry log-${kind}`;
  entry.open = open;
  const summary = document.createElement('summary');
  summary.className = 'log-label';
  summary.textContent = label;
  entry.appendChild(summary);
  const pre = document.createElement('pre');
  pre.className = 'log-body json';
  let pretty = raw;
  try {
    pretty = JSON.stringify(JSON.parse(raw), null, '  ');
  } catch {}
  pre.innerHTML = highlightJSON(pretty);
  entry.appendChild(pre);
  appendLog(entry);
}

function getFormattedDate() {
  const today = new Date();
  return today.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

// Tools the agent always has, independent of the page's WebMCP tools. Keyed by
// the exact function name sent to the model so the run loop can dispatch them
// before falling back to the page-tool naming scheme.
const GLOBAL_TOOLS = {
  prev_page: {
    label: 'Previous page',
    declaration: {
      name: 'prev_page',
      description:
        'Navigate the current tab back to the previous page in its browsing ' +
        'history. Use this to undo a navigation or return to an earlier page.',
      parametersJsonSchema: { type: 'object', properties: {} },
    },
    async execute(tabId) {
      await chrome.tabs.goBack(tabId);
      await waitForPageLoad(tabId);
      return 'Navigated back to the previous page.';
    },
  },
};

// Build the Tools popover from GLOBAL_TOOLS so new entries appear automatically,
// each with its own persisted enable/disable checkbox.
function renderGlobalToolsMenu() {
  globalToolsList.innerHTML = '';
  for (const [name, tool] of Object.entries(GLOBAL_TOOLS)) {
    const option = document.createElement('label');
    option.className = 'model-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = isGlobalToolEnabled(name);
    checkbox.onchange = () => setGlobalToolEnabled(name, checkbox.checked);
    const text = document.createElement('span');
    text.textContent = tool.label || name;
    option.append(checkbox, text);
    globalToolsList.appendChild(option);
  }
}

renderGlobalToolsMenu();

function getConfig(tools = currentTools) {
  const systemInstruction = [
    'You are an assistant embedded in a browser tab.',
    'User prompts typically refer to the current tab unless stated otherwise.',
    'Use the provided tools to query page content when you need it.',
    `Today's date is: ${getFormattedDate()}.`,
    'If the user gives a relative date (e.g. "next Monday", "tomorrow", "in 3 days"), resolve it to an exact calendar date based on today before passing it to a tool.',
    'CRITICAL RULE: Only use the tools provided to you; do not assume or invent others.',
  ];

  const functionDeclarations = [
    ...Object.entries(GLOBAL_TOOLS)
      .filter(([name]) => isGlobalToolEnabled(name))
      .map(([, tool]) => tool.declaration),
    ...(tools || []).map((tool) => {
      const locationIndex = (tools || []).findIndex((t) => t.location === tool.location);
      return {
        name: `_${locationIndex}_${tool.name}`,
        description: tool.description,
        parametersJsonSchema: tool.inputSchema
          ? JSON.parse(tool.inputSchema)
          : { type: 'object', properties: {} },
      };
    }),
  ];
  return { systemInstruction, tools: [{ functionDeclarations }] };
}

function generateTemplateFromSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return null;
  }

  if (schema.hasOwnProperty('const')) {
    return schema.const;
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return generateTemplateFromSchema(schema.oneOf[0]);
  }

  if (schema.hasOwnProperty('default')) {
    return schema.default;
  }

  if (Array.isArray(schema.examples) && schema.examples.length > 0) {
    return schema.examples[0];
  }

  switch (schema.type) {
    case 'object':
      const obj = {};
      if (schema.properties) {
        Object.keys(schema.properties).forEach((key) => {
          obj[key] = generateTemplateFromSchema(schema.properties[key]);
        });
      }
      return obj;

    case 'array':
      if (schema.items) {
        return [generateTemplateFromSchema(schema.items)];
      }
      return [];

    case 'string':
      if (schema.enum && schema.enum.length > 0) {
        return schema.enum[0];
      }
      if (schema.format === 'date') {
        return new Date().toISOString().substring(0, 10);
      }
      // yyyy-MM-ddThh:mm:ss.SSS
      if (
        schema.format ===
        '^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\\.[0-9]{1,3})?)?$'
      ) {
        return new Date().toISOString().substring(0, 23);
      }
      // yyyy-MM-ddThh:mm:ss
      if (
        schema.format ===
        '^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'
      ) {
        return new Date().toISOString().substring(0, 19);
      }
      // yyyy-MM-ddThh:mm
      if (schema.format === '^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]$') {
        return new Date().toISOString().substring(0, 16);
      }
      // yyyy-MM
      if (schema.format === '^[0-9]{4}-(0[1-9]|1[0-2])$') {
        return new Date().toISOString().substring(0, 7);
      }
      // yyyy-Www
      if (schema.format === '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$') {
        return `${new Date().toISOString().substring(0, 4)}-W01`;
      }
      // HH:mm:ss.SSS
      if (schema.format === '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\\.[0-9]{1,3})?)?$') {
        return new Date().toISOString().substring(11, 23);
      }
      // HH:mm:ss
      if (schema.format === '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$') {
        return new Date().toISOString().substring(11, 19);
      }
      // HH:mm
      if (schema.format === '^([01][0-9]|2[0-3]):[0-5][0-9]$') {
        return new Date().toISOString().substring(11, 16);
      }
      if (schema.format === '^#[0-9a-zA-Z]{6}$') {
        return '#ff00ff';
      }
      if (schema.format === 'tel') {
        return '123-456-7890';
      }
      if (schema.format === 'email') {
        return 'user@example.com';
      }
      return 'example_string';

    case 'number':
    case 'integer':
      if (schema.minimum !== undefined) return schema.minimum;
      return 0;

    case 'boolean':
      return false;

    case 'null':
      return null;

    default:
      return {};
  }
}

// Cap on how long we wait for a navigation to report `complete`. Back/forward
// navigations (e.g. the prev_page tool) can be served from the bfcache and may
// restore instantly without firing a normal load `complete`, which would
// otherwise leave this promise pending forever and hang the agent run. On
// timeout we resolve (not reject) so the loop continues against whatever state
// the tab is in rather than freezing.
const PAGE_LOAD_TIMEOUT_MS = 30_000;

function waitForPageLoad(tabId) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const timer = setTimeout(done, PAGE_LOAD_TIMEOUT_MS);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') done();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// EXPERIMENTAL / WIP: specialized to webmcp-benchmark online partials; revisit later.
//
// Resolves when the bound run's destination page has settled its WebMCP tools
// after a navigation, so the next model turn sees the new page's tools and not
// the old ones. Single-shot: the resolver is cleared once it fires or times out,
// and every wait is bounded so a turn never blocks indefinitely.
//
// Resolution preference, by trustworthiness of the trigger:
//  1. A `ready`-tagged push (the project-specific `webmcp:ready` signal relayed
//     by content.js) means injection for the new route has finished and the full
//     tool set is enumerable. Resolve immediately on it. This is the whole point
//     of consuming the signal: deterministic instead of timeout-based.
//  2. A plain toolchange-driven push may be mid-batch (a partial set). A
//     `webmcp:ready` often follows within a few ms, so we give it a short grace
//     window and resolve at its end if no ready arrives. This keeps non-ready and
//     non-instrumented pages responsive while still preferring the settled signal.
//  3. No push at all (page emits neither) uses the outer timeout fallback.
//
// CAVEAT: pages outside the benchmark online partials never emit webmcp:ready, so they
// always resolve via path 2 or 3, i.e. on the grace/fallback timers rather than
// a real signal. This couples the generic inspector to our instrumented sites
// and should be reconsidered (e.g. fold the nav/timeout heuristics and this
// signal into one model) in a future pass.
const READY_GRACE_MS = 400;
function waitForToolsUpdate(run, timeout) {
  return new Promise((resolve) => {
    let graceTimer = null;
    const done = () => {
      clearTimeout(fallbackTimer);
      clearTimeout(graceTimer);
      run.onToolsUpdate = null;
      resolve();
    };
    const fallbackTimer = setTimeout(done, timeout);
    run.onToolsUpdate = (ready) => {
      if (ready) return done();                       // settled signal -> resolve now
      if (!graceTimer) graceTimer = setTimeout(done, READY_GRACE_MS);
    };
  });
}

// Grace given for a deferred navigation (tool returns, then the page navigates)
// to start. Not a load-bearing delay: watchNavigation resolves the moment a
// load actually starts and only waits the full grace when nothing navigates.
const NAV_START_GRACE_MS = 500;
const TOOLS_UPDATE_TIMEOUT_MS = 2000;

// Detects a navigation a tool batch triggered on the bound tab and waits for it
// to settle. Arm it (call) before running the batch so a load starting mid-call
// is caught, then call settle() after. The tab's `loading` status is the
// navigation-start signal (via tabs.onUpdated, already used here, so no extra
// webNavigation permission). settle() returns at once when nothing navigated;
// otherwise it waits for the load to finish and the destination page to
// re-report its tools, so the next model turn sees that page's tools instead of
// the previous page's. Every wait is bounded so a turn never hangs.
function watchNavigation(run) {
  let started = false;
  let wake = null;
  const onUpdated = (id, info) => {
    if (id === run.tabId && info.status === 'loading') {
      started = true;
      wake?.();
    }
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  return {
    async settle() {
      try {
        if (!started) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, NAV_START_GRACE_MS);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
        }
        if (!started) return;
        // The load may already be complete (a tool that waited for it inline),
        // so only wait when the tab is still loading; otherwise we'd block on a
        // `complete` that already fired until the page-load cap.
        const tab = await chrome.tabs.get(run.tabId).catch(() => null);
        if (tab?.status === 'loading') await waitForPageLoad(run.tabId);
        await waitForToolsUpdate(run, TOOLS_UPDATE_TIMEOUT_MS);
      } finally {
        chrome.tabs.onUpdated.removeListener(onUpdated);
      }
    },
  };
}

document.querySelectorAll('.collapsible-header').forEach((header) => {
  header.addEventListener('click', () => {
    header.classList.toggle('collapsed');
    const content = header.nextElementSibling;
    if (content?.classList.contains('section-content')) {
      content.classList.toggle('is-hidden');
    }
  });
});
