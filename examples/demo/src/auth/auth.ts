import { configure } from '../api/http';

export interface Credentials {
  email: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  userId: string;
}

configure('https://auth.example.dev');

export async function login(c: Credentials): Promise<LoginResponse> {
  return { token: c.email, userId: c.password === '' ? 'guest' : 'u1' };
}

export async function getSession(token: string): Promise<{ valid: boolean }> {
  return { valid: token.length > 0 };
}

export function hashPassword(pw: string): string {
  let acc = 5381;
  for (let i = 0; i < pw.length; i++) {
    acc = ((acc << 5) + acc) ^ pw.charCodeAt(i);
  }
  return (acc >>> 0).toString(16);
}

export function validatePassword(pw: string): string | null {
  if (pw.length < 8) return 'too short';
  if (!/[A-Z]/.test(pw)) return 'needs uppercase';
  return null;
}
