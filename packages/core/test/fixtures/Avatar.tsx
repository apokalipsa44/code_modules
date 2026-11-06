import { signToken } from './signing';

interface Props {
  /** user display name */
  name: string;
}

const AVATAR_ENDPOINT = '/api/avatar';

export function Avatar(props: Props): string {
  const border = true;
  return `<img data-endpoint="${AVATAR_ENDPOINT}" title="${props.name}" border="${border}">`;
}

export const AvatarButton = (props: Props) => {
  const click = () => {
    function report() {
      return 'clicked';
    }
    return signToken(report()) && props.name;
  };
  return `<button onClick>${click() && <span>{props.name}</span>}</button>`;
};

export default function Screen() {
  return (
    <div className="settings-screen">
      <Avatar name="michau" />
      <h1>User settings</h1>
      <button onClick={() => signToken('x')}>Save</button>
    </div>
  );
}
