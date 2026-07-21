# WebMCP - Model Context Tool Inspector

A Chrome Extension that allows developers to inspect, monitor, and execute tools exposed via the WebMCP API.

## Prerequisites

**Important:** This extension relies on the WebMCP browser API. Enable `chrome://flags/#enable-web-mcp` and relaunch Chrome before using it.

## Installation

You can install this extension either directly from the Chrome Web Store or manually from the source code.

### Option 1: Chrome Web Store (recommended)

Install the extension directly via the [Chrome Web Store](https://chromewebstore.google.com/detail/model-context-tool-inspec/gbpdfapgefenggkahomfgkhfehlcenpd).

### Option 2: Install from source

1.  **Download the Source:**
    Clone this repository or download the source files into a directory.

2.  **Install dependencies:**
    In the directory, run `npm install`.

3.  **Open Chrome Extensions:**
    Navigate to `chrome://extensions/` in your browser address bar.

4.  **Enable Developer Mode:**
    Toggle the **Developer mode** switch in the top right corner of the Extensions page.

5.  **Load Unpacked:**
    Click the **Load unpacked** button that appears in the top left. Select the directory containing `manifest.json` (the folder where you saved the files).

## Usage

1.  **Navigate to a Page:**
    Open a web page that exposes Model Context tools.

2.  **Open the Inspector:**
    Click the extension's action icon (the puzzle piece or pinned icon) in the Chrome toolbar. This will open the **Side Panel**.

3.  **Inspect Tools:**
    * The extension will inject a content script to query the page.
    * A table will appear listing all available tools found on the page.

4.  **Execute a Tool:**
    * **Tool:** Select the desired tool from the dropdown menu.
    * **Input Arguments:** Enter the arguments for the tool in the text area.
        * *Note:* The input must be valid JSON (e.g., `{"text": "hello world"}`).
    * Click **Execute Tool**.

## Choosing a model provider

The "Interact with the Page" section can drive tools with Gemini, Volcano
Engine ARK (Doubao), or DeepSeek. Open the advanced menu (the `⋮` button next
to the prompt) to pick a provider, model, and thinking mode where supported.

* **Gemini:** set a [Gemini API key](https://aistudio.google.com/apikey) via
  the **Set Gemini API key** button.
* **ARK (Doubao):** select the ARK provider, then set an
  [ARK API key](https://www.volcengine.com/docs/82379). ARK speaks an
  OpenAI-compatible chat-completions endpoint
  (`https://ark.cn-beijing.volces.com/api/v3` by default). Pick a model from the
  list, or choose **Custom** to enter any model id or `ep-` endpoint id.
  * **Thinking** defaults to **Off** for lower latency. Doubao Seed 2.x's
    reasoning budget roughly triples response time; turn it **On** or **Auto**
    if you want the model to reason. Models marked "no thinking" ignore the
    setting.
* **DeepSeek:** select the DeepSeek provider, then set a
  [DeepSeek API key](https://platform.deepseek.com). DeepSeek speaks an
  OpenAI-compatible chat-completions endpoint (`https://api.deepseek.com` by
  default). The built-in model choices are `deepseek-v4-flash` and
  `deepseek-v4-pro`. The older `deepseek-chat` and `deepseek-reasoner` aliases
  are not listed because DeepSeek has announced their July 24, 2026
  deprecation.

Keys and selections are stored in the side panel's `localStorage`. You can also
ship defaults in an optional `.env.json` next to `sidebar.html`:

```json
{
  "provider": "ark",
  "arkApiKey": "...",
  "arkModel": "doubao-seed-2-0-pro-260215",
  "arkThinking": "disabled",
  "deepseekApiKey": "...",
  "deepseekModel": "deepseek-v4-flash",
  "deepseekThinking": "disabled",
  "apiKey": "...",
  "model": "gemini-3-flash-preview"
}
```

## Differences from upstream

This is a fork of [beaufortfrancois/model-context-tool-inspector](https://github.com/beaufortfrancois/model-context-tool-inspector). On top of the upstream inspector it adds:

* **More model providers** for "Interact with the Page": Volcano Engine ARK (Doubao) and DeepSeek, alongside the original Gemini driver. Each provider has its own model list, API-key input, and (where supported) thinking-mode toggle.
* **Robust tool discovery** that survives navigation: tools surface on load instead of waiting for `list_tools`, the `webmcp:ready` signal drives post-navigation waits, discovery is restricted to the top frame, and overlapping ticks or tab switches no longer corrupt an active run.
* **JSON syntax highlighting** in the tools table via a vendored highlight.js bundle, with collapsible entries and a sized, scrollable table.
* **Agent log formatting** into role-tagged entries, plus UX polish: prompt suggestion as a button, per-tool enable/disable menu, "previous page" as a global agent tool, copy-trace feedback, and reset-aware run cancellation.

## License

Apache License 2.0. See [LICENSE](LICENSE).

## Disclaimer

This is not an officially supported Google product. This project is not
eligible for the [Google Open Source Software Vulnerability Rewards
Program](https://bughunters.google.com/open-source-security).
