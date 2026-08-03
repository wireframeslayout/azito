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
| JavaScript | `.js`, `.jsx` |
| TypeScript | `.ts`, `.tsx` |
| Python | `.py` |
| Rust | `.rs` |
| Go | `.go` |
| HTML | `.html` |
| CSS | `.css` |
| JSON | `.json` |
| YAML | `.yml`, `.yaml` |
| Markdown | `.md` |
| Shell | `.sh`, `.bash` |

Other languages are auto-detected within the range highlight.js supports.

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

You can open files and folders directly in an external editor from the file preview view.

### Supported Editors

| Editor | Button | URI Scheme |
|---|---|---|
| VS Code | "Open in VS Code" | `vscode://` |
| Zed | "Open in Zed" | `zed://` |

### Automatic Tailscale Hostname Detection

When opening a file on a remote server in an external editor, AZITO automatically detects the Tailscale hostname and generates a URI for an SSH remote connection.

- The server's Tailscale hostname is retrieved automatically.
- For VS Code: a URI of the form `vscode://vscode-remote/ssh-remote+<host>/<path>` is generated.

### Folder-Level Operations

Beyond a single file, you can also open a directory (folder) in an external editor. Performing the action on a directory in the file explorer opens that directory as a workspace in the external editor.
