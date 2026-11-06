import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { CheckRunnerLike } from './types';

const execP = promisify(exec);

/**
 * Check runner: shells out to a configured READ-ONLY command (default none).
 * Example: npx tsc --noEmit
 * Parses plain "file(line,col): TSxxxx: message" and compiler-style diagnostics.
 */
export function createCheckRunner(command: string, cwd: string): CheckRunnerLike | null {
  if (!command.trim()) return null;
  return {
    async run() {
      try {
        const { stdout } = await execP(command, { cwd, timeout: 120000 });
        return { ok: true, summary: `check ok (${command})`, diagnostics: parseDiagnostics(stdout) };
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        const out = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n');
        const diagnostics = parseDiagnostics(out);
        return {
          ok: false,
          summary: `check failed (${command}): ${diagnostics.length} diagnostic(s)`,
          diagnostics: diagnostics.length ? diagnostics : [{ file: cmdFile(cwd), message: out.slice(0, 400), severity: 'error' }],
        };
      }
    },
  };
}

function cmdFile(cwd: string): string {
  return cwd.replace(/\\/g, '/').split('/').pop() ?? cwd;
}

export function parseDiagnostics(out: string): Array<{ file: string; message: string; line?: number; severity?: string }> {
  const diagnostics: Array<{ file: string; message: string; line?: number; severity?: string }> = [];
  const re = /^(.+?)\((\d+)[,)?](\d+)?[^:]*:\s*(?:error|warning)?\s*(TS\d+:\s*.+)$/gm;
  let m: RegExpExecArray | null = re.exec(out);
  while (m && diagnostics.length < 50) {
    diagnostics.push({
      file: (m[1] ?? '').replace(/\\/g, '/'),
      line: Number(m[2] ?? 0),
      severity: /error/.test(m[0]) ? 'error' : 'warning',
      message: (m[4] ?? m[3] ?? '').trim(),
    });
    m = re.exec(out);
  }
  return diagnostics;
}
