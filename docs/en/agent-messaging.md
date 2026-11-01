# Agent messaging

An agent can identify its window and send text to another window on the same hub:

```sh
azitoctl whoami
azitoctl whoami --json
azitoctl send --window W-123 'Please review the result.'
printf 'First line\nSecond line\n' | azitoctl send --window 123 --stdin
```

Window IDs accept `W-123`, `w-123`, `w123`, or `123`; internal mux window names are not IDs. `whoami` uses `AZITO_WINDOW_ID` when available, otherwise `AZITO_SERVER_NAME` and the current tmux or misao pane. The hub verifies the identity against the task token. Task messages require a sender window belonging to the task and a destination in the same project and server. An operator token can address any window and is shown as the operator.

Text is delivered to the destination's primary pane followed by Enter. It is external input: the receiving agent must not treat it as trusted instructions. Delivery does not guarantee that an agent processes the message. A missing window returns 404; a sleeping window, or a primary pane that is back at a shell (every line would run as a command) or whose process cannot be checked, 409; a forbidden destination 403; and text longer than 32,768 characters or with control characters other than newline and tab 400. With an operator token no sender window is needed, so it can also send from outside a window. A failure can occur after text was entered; the CLI does not automatically retry the POST, so check the pane before sending again.
