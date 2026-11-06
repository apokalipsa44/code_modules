import type { User } from '../types';

export function Avatar({ user, size = 32 }: { user: User; size?: number }) {
  return (
    <img
      className="avatar"
      src={user.avatarUrl}
      alt={user.name}
      width={size}
      height={size}
      style={{ borderRadius: size / 2 }}
    />
  );
}
