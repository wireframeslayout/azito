export class WindowExistsError extends Error {
  readonly windowName: string;
  constructor(windowName: string) {
    super(`Window "${windowName}" already exists`);
    this.name = 'WindowExistsError';
    this.windowName = windowName;
  }
}
