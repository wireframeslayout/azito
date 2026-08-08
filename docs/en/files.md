# File Operations Guide

## File Explorer

Selecting **Files** mode in the workspace activity bar shows the file tree on the project's server.

### Basic Operations

- Click a directory to expand / collapse it.
- Click a file to open a preview tab in the main area.
- The breadcrumb shows the current path.

### File Tree Structure

The file tree is rooted at the project's `workingDirectory`. Directory expansion is requested from the server in real time, so the latest file state is reflected.

## File Preview

Clicking a file shows a preview in the main area.

### Syntax Highlighting

Multi-language code highlighting is supported via highlight.js.

| Language | Extensions |
|---|---|
| TypeScript | `.ts`, `.tsx` |
| JavaScript | `.js`, `.jsx` |
| JSON | `.json` |
| CSS | `.css` |
| XML / HTML | `.xml`, `.html`, `.svg` |
| Markdown | `.md` |
| Python | `.py` |
| Bash / Shell | `.sh`, `.bash` |
| YAML | `.yml`, `.yaml` |
| SQL | `.sql` |

These are the explicitly registered languages. Others are attempted via highlight.js auto-detection.

#### Markdown Display Modes

Markdown files support three display modes:

| Mode | Description |
|---|---|
| Source | Displayed as source code with syntax highlighting |
| Preview | Rendered Markdown view |
| Split | Side-by-side Source and Preview |

### Image Preview

Image files in the following formats are previewed inline.

| Format | Extensions |
|---|---|
| PNG | `.png` |
| JPEG | `.jpg`, `.jpeg` |
| GIF | `.gif` |
| WebP | `.webp` |
| SVG | `.svg` |
| BMP | `.bmp` |
| ICO | `.ico` |
| TIFF | `.tiff`, `.tif` |

Images are fetched through a server-side proxy endpoint and displayed Base64-encoded.

### PDF Preview

PDF files (`.pdf`) are previewed using an embedded viewer.

### Storage Image Preview

When selecting an image file in the file storage (MinIO) file list, a preview is displayed within the sidebar. On mobile, clicking the image preview automatically closes the sidebar.

## Download

Clicking the download button at the top of the file preview view downloads the file to your browser.

### Limitations

- Maximum file size: **50MB**.
- Binary files are supported (non-text files can also be downloaded).
- Downloads go through a proxy endpoint on the AZITO server.

### Endpoint

```
GET /api/servers/:name/files/download?path=<filepath>
```

## External Editor Integration

You can open files directly in an external editor from the file preview view.

### Supported Editors

| Editor | Button | URI Scheme |
|---|---|---|
| VS Code | "Open in VS Code" | `vscode://` |
| Zed | "Open in Zed" | `zed://` |

In both cases, the **file's parent directory** is opened as the editor's workspace.

### Automatic Tailscale Hostname Detection

When opening a file on a remote server in an external editor, AZITO automatically detects the Tailscale hostname and generates a URI for an SSH remote connection.

- VS Code: `vscode://vscode-remote/ssh-remote+<host>/<parent-dir>`
- Zed: `zed://ssh/<host>/<parent-dir>`

## Browser Runtime (Chromium)

To use AZITO's CDP browser features (tab snapshots, agent operations, etc.), Chromium must be installed on the server.

### Prerequisites

- **Linux or macOS** only (Windows is not supported)
- **Node.js v24+** must be installed on the host (required for `npx`)

### Installation

1. Go to Servers → target server → Setup tab
2. Click the **Install** button under "Browser runtime (Chromium)"
3. Wait for the installation to complete (timeout: 10 minutes)

Internally this runs `npx playwright install chromium`, pinned to the Playwright version installed on the Hub.

### Additional Steps on Linux

On Linux, the **Noto Sans CJK JP** font is automatically installed for Japanese text rendering (placed in `~/.local/share/fonts/`). Font installation failure does not block the Chromium install (non-fatal).

### API

```
POST /api/servers/:name/install-browser-runtime
```

Response: `{ ok, chromiumVersion, fontInstalled, warning }`
