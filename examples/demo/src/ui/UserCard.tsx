import { Avatar } from './Avatar';
import type { User } from '../types';

export function UserCard({ user, onMessage }: { user: User; onMessage: (u: User) => void }) {
  return (
    <div className="user-card">
      <Avatar user={user} size={44} />
      <div className="user-card-meta">
        <strong>{user.name}</strong>
        <button onClick={() => onMessage(user)}>Message</button>
      </div>
    </div>
  );
}

export function UserList({ users }: { users: User[] }) {
  return (
    <ul className="user-list">
      {users.map((u) => (
        <li key={u.id}>{u.name}</li>
      ))}
    </ul>
  );
}
