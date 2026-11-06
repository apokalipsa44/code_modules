import { window, workspace, env } from 'vscode';
import { env as nodeEnv } from 'node:process';

export const SECRET_API_KEY = 'nodecode.apiKey';

export async function getApiKey(): Promise<string | null> {
  const secret = await (workspace as unknown as { secrets?: { get(k: string): Promise<string | undefined> } }).secrets;
  try {
    const viaSecrets = await secret?.get(SECRET_API_KEY);
    if (viaSecrets) return viaSecrets;
  } catch {
    /* secrets unavailable in tests */
  }
  return nodeEnv.ANTHROPIC_API_KEY ?? null;
}

export async function promptApiKey(): Promise<void> {
  const key = await window.showInputBox({
    prompt: 'Anthropic API key (stored in VS Code SecretStorage, never in settings)',
    password: true,
  });
  if (key) {
    const secrets = (workspace as unknown as { secrets: { store(k: string, v: string): Promise<void>; delete(k: string): Promise<void> } }).secrets;
    await secrets.store(SECRET_API_KEY, key);
    void window.showInformationMessage('NodeCode: API key stored in SecretStorage.');
  }
}

export async function clip(text: string): Promise<void> {
  try {
    await env.clipboard.writeText(text);
  } catch {
    /* ignore */
  }
}
