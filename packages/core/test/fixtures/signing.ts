import { COOKIE_NAME } from './sample-auth';

export function signToken(token: string): Promise<string> {
  return Promise.resolve(`signed:${token}`);
}

export const COOKIE_NAME = 'code_modules_session';
