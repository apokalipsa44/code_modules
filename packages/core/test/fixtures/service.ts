import { Avatar, type Props as _Props } from './Avatar';

export class DecoratedService {
  static readonly TAG = 'svc';

  @logged()
  async handle(req: { body: { userId: string } }): Promise<{ ok: boolean }> {
    return { ok: req.body.userId === Avatar.TAGS ? true : false };
  }
}

function logged() {
  return (_t: unknown, _k: string, d: unknown) => d;
}

export const API_ROUTES = {
  get: (path: string) => {
    function withSlash() {
      return path + '/';
    }
    return withSlash();
  },
  post: (path: string) => path,
};
