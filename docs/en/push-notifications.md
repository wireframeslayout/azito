# Push Notifications Setup Guide

AZITO supports PWA push notifications to alert you when tasks complete or fail. Because push notifications require a secure context (HTTPS), this guide uses Tailscale Serve to create an HTTPS endpoint.

## Prerequisites

- Tailscale installed and connected to your tailnet
- AZITO backend running (default port 3001)
- Vite dev server running (default port 5173)

## Step 1: Enable Tailscale Serve

First, allow your user account to manage `tailscale serve` without sudo. This is a one-time setup:

```bash
sudo tailscale set --operator=$USER
```

Then start the HTTPS proxy pointing to the Vite dev server:

```bash
tailscale serve --bg http://localhost:5173
```

This creates an HTTPS endpoint at:

```
https://<your-machine>.tail<xxxxx>.ts.net
```

You can verify it is running with:

```bash
tailscale serve status
```

## Step 2: Configure Vite (already done)

The Vite config (`vite.config.ts`) needs `allowedHosts: true` in the server configuration to accept requests from the Tailscale hostname. This is already configured in the AZITO project -- no action needed.

## Step 3: Access via HTTPS

Open your Tailscale HTTPS URL in a browser:

```
https://<your-machine>.tail<xxxxx>.ts.net
```

You must use this HTTPS URL for push notifications to work. Notifications will not function over plain HTTP (e.g., `http://localhost:5173`).

## Step 4: Subscribe to notifications

1. Open the Workspace for any project.
2. Go to **Settings** (gear icon in the activity bar).
3. Find the **Notifications** section.
4. Click **Enable Notifications**.
5. When the browser displays a permission prompt, click **Allow**.

Once subscribed, AZITO registers your browser with the server using the VAPID protocol. The server generates VAPID keys automatically on first run.

## Step 5: Test

Send a test notification from the command line:

```bash
curl -X POST http://localhost:3001/api/notifications/test
```

You should see a push notification appear in your OS notification center with the message "Push notifications are working!".

If you get `No push subscriptions registered`, go back to Step 4 and make sure you subscribed.

## Mobile Setup

### iOS (iPhone / iPad)

1. Open the Tailscale HTTPS URL in **Safari**.
2. Tap the **Share** button, then select **Add to Home Screen**.
3. Open AZITO from the home screen icon.
4. Navigate to Settings > Notifications > **Enable Notifications**.
5. Allow the permission prompt.

Requirements:
- iOS 16.4 or later
- Must open from the home screen app icon, not a Safari tab

### Android

1. Open the Tailscale HTTPS URL in **Chrome**.
2. Chrome will prompt you to install the PWA -- tap **Install** or **Add to Home Screen**.
3. Open AZITO from the home screen.
4. Navigate to Settings > Notifications > **Enable Notifications**.
5. Allow the permission prompt.

## Notification Events

AZITO sends push notifications for the following events:

| Event | Description |
|---|---|
| Task completed (`done`) | A task finished successfully |
| Task failed (`error` / `send_error` / `codex_error`) | A task encountered an error |
| Task stopped (`stopped_by_user`) | A task was stopped by the user |
| Task has questions (`waiting_for_human`) | A task generated questions for you |
| Phase review (`phase_review`) | A task's phase result is ready for review |
| Agent Finished (activity-based) | An agent transitioned from running to idle |
| Approval Required (activity-based) | An agent transitioned to a blocked (waiting-for-approval) state |

Each task-status notification includes the task title and a link back to the relevant workspace. The task-status events (done, the error variants, stopped_by_user, waiting_for_human, phase_review) are sent by subscribing to task status changes; "Agent Finished" and "Approval Required" are sent independently of any task, based on `AgentActivityMonitor`'s activity detection (a running -> idle or working -> blocked transition).

Note: push notifications used to be sent via the Claude Code hook (`azito-notify.sh`). They have since been replaced by the activity-detection-based notifications above. The hook endpoint (`/api/webhooks/agent-done`) still exists for backward compatibility, but no longer sends push notifications.

## Troubleshooting

### "Not supported" message when enabling notifications

Push notifications require HTTPS. Make sure you are accessing AZITO through the Tailscale HTTPS URL, not `http://localhost` or an IP address.

### Subscribed but no notifications arrive

- Check your OS notification settings for the browser (System Settings > Notifications).
- On macOS, ensure the browser is allowed to show notifications.
- On Windows, check Focus Assist / Do Not Disturb settings.
- Try sending a test notification with `curl -X POST http://localhost:3001/api/notifications/test`.

### iOS: notifications not working

- You must be on iOS 16.4 or later.
- AZITO must be opened from the **home screen icon**, not from a Safari tab.
- Check Settings > Notifications on your iPhone and ensure the AZITO PWA is listed and allowed.

### Unsubscribing

To stop receiving notifications, go to Settings > Notifications and click **Disable Notifications**. This removes your subscription from both the browser and the server.
