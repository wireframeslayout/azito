# Workspace Guide

The Workspace is the primary interface for interacting with a project in AZITO. It combines terminal access, agent management, file browsing, and issue tracking into a single, tab-based view.

## Layout

The Workspace is divided into four areas:

```
+------------------+-----+------------------+----------------------------+
| Project Bar      |     |                  |                            |
| (left edge)      | Act.| Sidebar          | Main Content Area          |
|                  | Bar |                  |                            |
| [Project 1]      |     | (context list)   | (terminal, file preview,   |
| [Project 2]      |     |                  |  task logs, etc.)          |
| [Project 3]      |     |                  |                            |
+------------------+-----+------------------+----------------------------+
```

- **Project Bar** -- A narrow vertical bar on the far left showing all your projects. Click a project name to switch.
- **Activity Bar** -- Icon buttons that switch the sidebar mode.
- **Sidebar** -- Shows context-specific lists and controls depending on the active mode.
- **Main Content Area** -- Displays the content for the selected tab (terminal, file, task log, etc.).

Sidekicks (tagged skill packages), Units (the team that runs an operation), and Operations (execution
runs of a Unit) are global resources shared across all projects, not something bound to a single
project. They aren't part of the per-project sidebar — open them as tabs in the main area from the top
**Units** / **Sidekicks** / **Operations** navigation links.

## Sidebar Modes

Click icons in the Activity Bar to switch between sidebar modes.

### Windows

The default mode. Lists all tmux windows and panes assigned to the current project. Click a pane to open it in the main area as a full terminal (xterm.js with WebSocket connection).

- When removing a window, all open tabs associated with that window's panes are automatically closed.
- Right-click a window for a context menu with Detach/Delete plus an "Add to Project" submenu, which lets you add the window to any other project (projects it's already added to show as selected).
- Windows with an active agent show a neon shimmer (gradient sheen) and a braille spinner; working / blocked / finished indicators are shown across all window lists (sidebar, task window lists, and dropdowns).
- The sidebar width is synced across all projects.

### Tasks

Lists tasks for the project. Each task runs under a Unit (workflow definition + execution runtime),
which in turn assigns a Sidekick (tagged skill package) to each phase. You can:

- View task status and logs
- Create new tasks (manually or from a GitHub/GitLab issue)
- Monitor running tasks in real time via streaming logs

### Files

A file explorer for browsing the project's working directory on the server. Features:

- Directory tree navigation
- Syntax-highlighted file preview (powered by highlight.js)
- Click a file to open it in a preview tab
- PDF file preview support
- Image file preview (PNG, JPEG, GIF, WebP, SVG, BMP, ICO, TIFF)

### Repositories

Lists GitHub and GitLab repositories linked to the project. Select a repository to browse its issues in the main content area. See [GitHub/GitLab Integration](github-integration.md) for setup details.

### Storage

File storage panel powered by MinIO. Upload files, view thumbnails for images, and copy shareable URLs. See [File Storage Guide](storage.md) for setup.

### Settings

Project configuration panel with sections for:

- **General** -- Project name, description, repository URL, default branch, sidekick prompt (extra project-level instructions injected into phase prompts)
- **Repositories** -- Add or remove linked repositories
- **Servers** -- Configure per-server working directories and branches, and the project's default Unit
- **Danger Zone** -- Delete the project

## Tab Management

All content in the main area opens in tabs along the top edge. Tab types include:

| Prefix | Content |
|---|---|
| `terminal:` | Terminal view (xterm.js) for a tmux pane. Inactive tabs disconnect and reconnect automatically on re-activation to save memory |
| `file:` | File preview with syntax highlighting |
| `task:` | Task detail and log view |
| `unit:` | Unit (workflow definition + execution runtime) detail/edit view |
| `sidekick:` | Sidekick (tagged skill package) detail/edit view |

### Active Windows

A section that stays docked at the bottom of the sidebar, listing windows an agent is currently active on in real time.

> The old PiP (Picture-in-Picture) floating monitor and the capture-based Input mode were removed in v0.2.1. Active Windows is the monitoring surface.

- Running rows show a neon shimmer (a pink -> purple -> blue gradient sheen) and a braille spinner.
- Blocked rows (waiting for approval) show an orange ripple animation and an "Approval Required" label.
- After an agent finishes, the entry stays in the list as an "unacknowledged completion" (green checkmark + elapsed time) until you view it.
- Rows belonging to a task open that terminal inside the task detail tab when tapped (rows with no task open a plain terminal tab instead).
- Tapping a row also moves the workspace focus to the project the window belongs to.
- Watched-state is tracked per pane: only panes actually being displayed count as watched, so blocked/finished states of hidden windows in multi-window tasks show up correctly.
- The window name is shown as a dimmed second line under the label.
- The section auto-collapses to just its header while the count is 0, and auto-expands the moment it goes from 0 to 1+.
- The expand/collapse toggle state and the unacknowledged-completion entries are persisted to localStorage and restored after reload.
- On mobile (≤768px), open the glass-panel list from the Active Windows button (with a count badge) in the floating menu bar.

### Tab interactions

- **Click** a tab to switch to it.
- **Mouse wheel** on the tab bar to scroll when tabs overflow.
- **Right-click** a tab to open a context menu (close, close others, close all).
- Tabs are persisted in localStorage per project, so they survive page reloads.
- **Activity indicator** -- Tabs with an active agent show a neon comet (pink -> purple -> blue gradient) animation and a braille spinner along their bottom edge (falls back to a static indicator when `prefers-reduced-motion` is set).

## Theme and Appearance

Settings > Appearance lets you customize the look of terminals and the whole workspace (live editing, applied instantly — no save button).

- **7 preset themes** -- Azito Aurora (default, pink -> blue gradient) / GitHub Dark / Dracula / Nord / Solarized Dark / Monokai / One Dark
- **Color customization** -- Edit background, foreground, cursor, selection, and all 16 ANSI colors individually. Editing switches the preset to a custom theme
- **Custom themes** -- Save your palette + background settings under a name; select, overwrite, or delete saved themes
- **Background customization** -- Choose from 4 gradient patterns (aurora / linear / glow / mesh), an image (URL or IndexedDB-stored), or a solid color. Images support 6 overlay effects (darken / color / blur / gradient / vignette / none)
- **Scope** -- Switch between "terminal only" and "entire screen". In entire-screen mode, workspace surfaces (sidebar, tab bar, forms) become translucent with blur so the background shows through (floating UI stays opaque)
- **UI border color** -- Configurable per theme
- **Per-project themes** -- Assign a theme per project; it applies automatically when switching tabs
- Settings persist to localStorage (`azito-terminal-theme`; background images to IndexedDB) and apply to xterm.js dynamically without reconnecting the WebSocket

## Page Navigation

List, form, and detail screens now share a unified layout shell.

- **PageContainer** -- A centered container with a 1400px max width, providing common spacing and scroll handling for all page bodies.
- **PageHeader / PageBody** -- Layout parts that separate the page's top heading/action area (PageHeader) from its main content (PageBody).
- **EyebrowBack** -- A "back to list" link shown above the title on detail/form screens. It follows the opener-tab relationship (the tab that opened the current tab) back to the originating list tab.
- **Unit detail page** -- Redesigned into three sections: "Now Running" (currently running Operations), "Behavior" (phase configuration and other behavior settings), and "Tasks" (tasks executed under this Unit).

## URL Navigation

The Workspace URL follows the pattern:

```
/workspace/:projectId/:sidebarMode
```

For example, `/workspace/3/repos` opens project 3 with the Repositories sidebar active. Valid mode values: `windows`, `tasks`, `files`, `repos`, `storage`, `settings`, `servers`.

## Mobile Support

AZITO is optimized for mobile browsers with the following features:

- **Floating menu bar (MobileMenuBar)** -- A floating menu docked at the bottom of the screen, with a left group (project switcher / task list / files / more) and a right group (keyboard control / notifications / settings). It slides down out of view automatically while the soft keyboard is visible.
- **Mobile sidebar** -- Same activity bar + sidebar layout as desktop, sized and spaced for touch.
- **Project switching** -- Tapping the project icon in the floating menu bar opens a project-switcher popover; each project is identified by its icon and color.
- **SP keyboard control overlay** -- Opened from the keyboard icon in the floating menu bar. It's draggable and rendered at 40% opacity, letting you send commands (arrow keys, Ctrl+C, etc.) to the currently displayed window without needing focus.
- **Notifications menu** -- Renders as a full-screen overlay.
- **Active Windows panel** -- The Active Windows button (with a running-count badge) in the floating menu bar opens a glass-panel list of active windows.
- **Touch swipe scrolling** -- Terminal views support touch swipe scrolling with inertia/momentum.
- **Quick action buttons** -- On mobile viewports (768px and below), quick action buttons (Enter, Tab, Esc, Ctrl+C, Arrow Up, Arrow Down) appear above the terminal.
- **Long-press context menus** -- Long-press on server, session, window, and pane rows in the sidebar, or on tabs, to open context menus (equivalent to right-click).
- **Kanban multi-line titles** -- Task titles on the kanban board wrap to 2 lines instead of truncating to a single line.
- **PWA support** -- Use "Add to Home Screen" in the browser to use AZITO as a native-like app (HTTPS required).

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+B` | Toggle sidebar visibility |

## Sidebar Resize

The sidebar can be resized by dragging its right edge (200px-600px). Double-click resets it to the default width (320px). The width is remembered across sessions and shared across all projects. When collapsed via `Ctrl+B`, the sidebar hides completely to maximize the main content area.
