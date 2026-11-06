export interface User {
  id: string;
  name: string;
  avatarUrl: string;
}

export type SessionState =
  | { guest: true }
  | { guest: false; user: User; token: string };
