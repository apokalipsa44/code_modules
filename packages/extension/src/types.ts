// Shared extension-side types (no vscode import here).

export interface FileRegistry {
  /** All scannable workspace files (posix relative paths). */
  list(): Promise<string[]>;
  /** Read raw file content; returns null when missing. */
  read(file: string): Promise<string | null>;
  exists(file: string): boolean;
}

export interface CheckRunnerLike {
  /** Read-only checks; returns diagnostics. */
  run(): Promise<{ ok: boolean; summary: string; diagnostics: Array<{ file: string; message: string; line?: number; severity?: string }> }>;
}

export interface ProgressLike {
  report(message: string, increment?: number): void;
}

export interface WebviewBridge {
  post(message: unknown): void;
  dispose(): void;
}
