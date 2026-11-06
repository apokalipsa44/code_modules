export interface RequestOptions {
  baseURL: string;
  headers?: Record<string, string>;
}

let activeBase = 'https://api.example.dev';

export function configure(base: string): void {
  activeBase = base;
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(activeBase + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
  return (await res.json()) as T;
}
