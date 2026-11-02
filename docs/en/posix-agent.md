# macOS and Linux agent servers

AZITO can install an agent over SSH on Linux x64 or arm64 and Apple Silicon macOS with arm64 Node. Intel Macs and x64 Node running under Rosetta are not supported. Windows agents are described in [Windows agent servers](./windows-agent.md).

## Prepare and add

Install Node.js 24 or later and Tailscale on the target, and make them available in the target user's login shell. The installer also checks the Tailscale application CLI on macOS. tmux is optional when misao is available. Configure SSH access using the normal AZITO setup, then select **Servers → Add → Agent** and enter the SSH host. The preflight reports missing commands and the Node architecture before deployment.

The same agent bundle contains Linux x64 and arm64 native modules and the macOS prebuild. AZITO installs a matching misao binary separately. An agent update does not stop misao; explicitly updating misao can close its panes.

## Services and limits

Linux uses a user systemd service where available and otherwise a background process. On macOS, the agent uses a Background launchd job in `user/<uid>`, independent of the GUI domain. That user domain must exist: a reboot can require a user login before launchd starts the job. Logging out of the GUI does not itself stop a job in an available background domain. The agent and misao can continue while the hub is stopped; their availability depends on the host and user domain. The macOS misao daemon is a separate background process and has no new automatic restart mechanism here.

The Mac agent can be removed from its server row. Removal checks the managed job and installation ID before deleting agent files. If misao removal is requested but ownership cannot be established, the operation reports a failure and leaves misao in place. Linux host removal is not yet supported; removing the server row only forgets it in the hub.

## Troubleshooting

If preflight cannot find Node or Tailscale, check the target user's login shell PATH and shell startup files. Use an arm64 Node on Apple Silicon, including when the machine also has Rosetta. A missing tmux is acceptable only if misao installs successfully. If launchd cannot bootstrap, check that `user/<uid>` exists and inspect the agent log under `~/.azito/agent/agent.log`. A job with an unrecognized definition is left untouched; inspect its owner before retrying. Actual reboot, logout and recovery behavior should be checked on the target environment.
