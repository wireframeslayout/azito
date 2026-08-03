# GitHub / GitLab Integration Guide

AZITO can link GitHub / GitLab repositories to a project so you can browse issues, search them, and convert them into tasks. Self-hosted GitLab instances are also supported.

## Adding a Repository

### From the Workspace Sidebar

1. Select the **Repositories** mode in the workspace activity bar
2. Click the "+" button
3. Fill in the following details

| Field | Description |
|---|---|
| Provider | Select `GitHub` or `GitLab` |
| Repository URL | Repository URL (e.g. `https://github.com/owner/repo`) |
| Owner | Repository owner name (auto-filled from the URL) |
| Repo | Repository name (auto-filled from the URL) |
| Name | Display name (optional; defaults to `owner/repo` when omitted) |
| Token | Access token (optional; see the authentication methods below) |

4. Click the **Add** button

### From Settings

You can also add a repository the same way from the Repositories section of the workspace's Settings mode.

## Authentication

AZITO resolves tokens in the following order of priority.

### GitHub

1. **Per-repository token** -- the Personal Access Token (PAT) entered in the Token field when adding the repository
2. **`gh` CLI token** -- if you have run `gh auth login` on the server, the token is fetched automatically via the `gh auth token` command. For GitHub Enterprise Server (see below), the token is resolved per host via `gh auth token --hostname <host>`

Authenticating with the `gh` CLI is recommended.

```bash
# Log in with the GitHub CLI (first time only)
gh auth login
```

### GitLab

1. **Per-repository token** -- the personal access token entered in the Token field when adding the repository
2. **`glab` CLI token** -- if you have run `glab auth login` on the server, the token is fetched automatically via the `glab config get token -h <host>` command

```bash
# Log in with the GitLab CLI (first time only)
glab auth login
```

### Setting a Token Manually

If you don't use the CLI, enter a token directly in the Token field when adding the repository.

- **GitHub**: Generate a token with the `repo` scope under Settings > Developer settings > Personal access tokens
- **GitLab**: Generate a token with the `read_api` scope under Settings > Access Tokens

## Browsing Issues

1. Select the **Repositories** mode in the workspace sidebar
2. Click a repository to select it
3. The issue list is displayed in the main area

The issue list supports the following operations:

- **Status filter** -- filter by Open / Closed / All
- **Pagination** -- load more with the "Load more" button (20 items per page)
- **Issue details** -- click an issue to open its details in a tab
- **External link** -- open the issue's GitHub / GitLab page in a new tab

## Searching Issues

Enter keywords in the search field at the top of the issue list, then press Enter or click the search button to run the search.

- GitHub: searches titles and bodies
- GitLab: searches titles and descriptions

Clearing the search returns you to the regular issue list.

## Pull Requests / Merge Requests

You can browse a repository's pull requests (GitHub) / merge requests (GitLab).

### Switching Tabs

When you select a repository, **Issues** / **Pull Requests** tabs appear at the top of the main area. Click a tab to switch views (for GitLab the tab is labeled "Merge Requests").

### Pull Request List

The Pull Requests tab lists the repository's pull requests.

- **Status badges** -- a color-coded badge is shown based on the PR's state
  - **Open** -- green (awaiting review / in progress)
  - **Merged** -- purple (merged)
  - **Closed** -- red (closed)
  - **Draft** -- gray (draft / work in progress)
- **Branch info** -- branch names are shown in `head → base` format (e.g. `feature/login → main`)
- **External link** -- clicking a PR opens its GitHub / GitLab page in a new tab
- **Pagination** -- load more with the "Load more" button (20 items per page)
- **Status filter** -- filter by Open / Closed / Merged / All

## Automatic PR/MR Creation

During a task's pushing phase, `PullRequestCreator` automatically creates the PR/MR server-side.

- It creates the PR/MR via the GitHub/GitLab API even in environments without the `gh` or `glab` CLI available (e.g. remote workers)
- It detects an existing PR/MR on the same branch first and skips creation if one is already open, avoiding duplicates
- It is best-effort: a creation failure (missing permissions, provider outage, unconfigured repository, etc.) is logged but never blocks push completion
- It supports GitHub Enterprise Server (GHE, self-hosted GitHub), automatically detecting the `<origin>/api/v3` endpoint from the repository URL's hostname

## Creating Tasks from Issues

### From the Issue List

Click the "Import" button on the right side of any issue in the issue list, and the task creation form opens with the issue's title and body pre-filled.

### From the Task Creation Modal

1. Select the **Tasks** mode in the workspace sidebar
2. Open the task creation modal with the "+" button
3. Click the "Import from Issue" button
4. Select a repository and search for the issue
5. Selecting an issue pre-fills the title and description

Imported tasks record their source information (e.g. `owner/repo#123`).

## GitLab Support

### gitlab.com

Select "GitLab" as the Provider and enter a URL in the form `https://gitlab.com/owner/repo`.

### Self-hosted GitLab

Self-hosted GitLab instances are also supported.

1. Select "GitLab" as the Provider
2. Enter your self-hosted GitLab URL in the Repository URL field (e.g. `https://gitlab.example.com/group/subgroup/repo`)
3. Enter the group / subgroup path in Owner and the repository name in Repo
4. Enter an access token in the Token field (or authenticate via the CLI with `glab auth login -h gitlab.example.com`)

AZITO automatically determines the hostname from the repository URL and uses the appropriate API endpoint.

## Troubleshooting

### Issues Are Not Displayed

- Check that the token is configured correctly
- Check the CLI authentication status with `gh auth status` (GitHub) or `glab auth status` (GitLab)
- Check that Owner and Repo are correct

### "Repository owner and name required" Error

The repository's Owner or Repo field is empty. Check the repository settings and re-enter the URL. Owner and Repo are auto-filled when you enter the URL.

### Cannot Connect to a Self-hosted GitLab

- Check that the GitLab URL is correct
- Check that the token has the `read_api` scope
- Check that the AZITO server can reach the GitLab server
