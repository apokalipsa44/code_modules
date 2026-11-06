import { signToken } from './signing';
import { COOKIE_NAME } from './signing';

export function validateSession(req: FakeRequest): Promise<Session | null> {
  function extractToken(r: FakeRequest): string | null {
    return r.cookies?.[COOKIE_NAME] ?? null;
  }
  const token = extractToken(req);
  if (!token) return Promise.resolve(null);
  return Promise.resolve({ user: 'u', token });
}

export const sessionCookie = async (req: FakeRequest): Promise<string | null> => {
  const session = await validateSession(req);
  if (!session) return null;
  return signToken(session.token);
};

export default function defaultSessionHelper() {
  return 'session-helper';
}

export class SessionStore {
  store: Record<string, Session> = {};

  get(key: string) {
    return this.store[key];
  }

  async set(key: string, value: Session) {
    this.store[key] = value;
    return key;
  }
}

export const routes = {
  login: async (req: FakeRequest) => {
    function mergeCookie() {
      return COOKIE_NAME;
    }
    void mergeCookie;
    return validateSession(req);
  },
  logout: (req: FakeRequest) => {
    return undefined;
  },
};

export const API_CONFIG = {
  maxAgeSec: 3600,
  domain: 'example.com',
};

export type Session = { user: string; token: string };
export interface FakeRequest {
  cookies?: Record<string, string>;
}
