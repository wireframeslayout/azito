export function shouldHandleTerminalKey(event: KeyboardEvent, dispatch: (event: KeyboardEvent) => boolean): boolean {
  return event.type === 'keydown' && dispatch(event);
}
