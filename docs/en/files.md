# File Operations Guide

## File Explorer

Selecting **Files** mode in the workspace activity bar shows the file tree on the project's server.

### Basic Operations

- Click a directory to expand / collapse it.
- Click a file to open a preview tab in the main area.
- The breadcrumb shows the current path.

### File Tree Structure

The file tree is rooted at the project's `workingDirectory`. Directory expansion is requested from the server in real time, so the latest file state is reflected.

### Creating, Deleting, and Renaming

Right-clicking a node in the file tree (long-press on mobile) opens a context menu with the following actions:

| Action | Description |
|---|---|
| New File | Create a file under the selected directory |
| New Folder | Create a folder under the selected directory |
| Rename | Rename the file or folder |
| Copy Path | Copy the full path to the clipboard |
| Download | Download the file (folders are not supported) |
| Delete | Show a confirmation modal, then delete |

Create and rename use an inline input field in the tree; only delete goes through a confirmation modal. The server always verifies that every write operation — create, save, rename, and delete — stays inside the project's `workingDirectory`; paths outside that root are rejected. Delete additionally rejects the `.git` directory and the root directory itself.

### Switching Worktree Roots

The root switcher row at the top of the sidebar lets you switch which worktree (branch) is currently displayed. That row shows the currently selected worktree's changed-file count as a badge. Clicking it opens a picker with a filterable list of worktrees on the project server, showing each branch name and the status of any task tied to it. Worktrees created for a running task show that task's status; among worktrees whose path matches `.worktrees/task-<taskId>`, one with no matching task is marked as orphaned.

## File Search

The search mode in the sidebar lets you search file names and file contents across the tree.

- Three inline toggles next to the search box — `Aa` (match case), `ab` (whole word), `.*` (regular expression) — narrow the search
- Expanding the details reveals "Files to Include" / "Files to Exclude" glob fields (default exclusions such as `node_modules`, `.git`, `dist`, `.worktrees`)
- File contents are searched with `rg` (ripgrep) when the server has it (it is fast, so installing it is recommended). On a Unix server without `rg`, `grep` is used; on a Windows server without `rg` (Windows has no `grep` either), AZITO's own search written in Node is used. A small label above the results (ripgrep / grep / built-in) shows which one searched
- The built-in search is not identical to `rg`. It does match `rg` on: the default excluded directories (`node_modules`, `.git`, `dist`, `.worktrees`); how the include / exclude globs are read (as `rg -g` reads them: `src/*.ts` means the files directly in the root's `src`, `src/private/**` leaves out everything below it); at most 5 lines per file; 1 MB for all the results together; and skipping binary files (those with a NUL byte; UTF-8 and UTF-16 files that start with a byte order mark are searched as text) and files over 10 MB. It differs in these ways: it does not read `.gitignore`, so it also searches files `rg` would skip; it searches hidden files (`.env`, `.github/`, ...) as `grep` does; regular expressions use JavaScript syntax, and "whole word" counts only ASCII letters, digits and `_` as word characters. A Unix server that has neither `rg` nor `grep` switches to it too. An older agent without the new search operation is refused with `agent_outdated` (update the agent)
- Result paths are relative to the search root with `/` separators, whichever program searched
- The search scope is also confined to the project's `workingDirectory`

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

## In-Browser Editor

For text files other than Markdown, the preview area itself is a CodeMirror 6-based editor — files are editable directly, with no separate "edit mode" to switch into. Markdown files have three switchable view modes — Source / Preview / Split — defaulting to Preview. The default Preview mode is read-only; switch to Source or Split to edit.

- **Vim mode**: a toggle at the top-right of the editor enables vim keybindings (the setting is persisted per device and off by default at mobile widths). In vim mode, `:w` also triggers a save
- **Saving**: edits are sent to `PUT /api/servers/:name/files/content` on save
- **Conflict detection**: the request includes the file's mtime and sha256 hash captured at load time (`baseMtime`/`baseHash`); if they no longer match the server's current values, the save is rejected as a conflict. A banner then lets you reload the server's latest content or force-overwrite it with your own edits (`force`)

## Git Diff View

The workspace's Diff tab shows a worktree's changes across three switchable scopes:

| Scope | Description |
|---|---|
| Uncommitted | Uncommitted changes in the working tree (including untracked files) |
| Compare with base | Diff against the merge-base with the base branch. An "Include uncommitted" toggle controls whether working-tree changes are included |
| Commit | The diff for a single selected commit |

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
