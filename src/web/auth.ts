import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { html, layout } from './views/html.js';

const SESSION_COOKIE = 'kzsu_session';
const SESSION_VALUE = 'ok';
const SESSION_MAX_AGE = 30 * 24 * 3600;

export function passwordMatches(config: Config, given: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(config.DASHBOARD_PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isAuthenticated(req: FastifyRequest): boolean {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return false;
  const unsigned = req.unsignCookie(raw);
  return unsigned.valid && unsigned.value === SESSION_VALUE;
}

function loginPage(error?: string): string {
  return layout(
    'Log in',
    html`
      <h1>Log in</h1>
      ${error ? html`<div class="banner warn">${error}</div>` : ''}
      <form method="post" action="/login">
        <label>
          Password
          <input type="password" name="password" autofocus required />
        </label>
        <button type="submit">Log in</button>
      </form>
    `,
  );
}

export function registerAuth(app: FastifyInstance, config: Config): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split('?')[0]!;
    if (path === '/login' || path === '/healthz') return;
    if (!isAuthenticated(req)) {
      return reply.redirect('/login');
    }
  });

  app.get('/login', async (_req, reply) => {
    return reply.type('text/html').send(loginPage());
  });

  app.post<{ Body: { password?: string } }>('/login', async (req, reply) => {
    const given = req.body?.password ?? '';
    if (!passwordMatches(config, given)) {
      return reply.code(401).type('text/html').send(loginPage('Wrong password.'));
    }
    return reply
      .setCookie(SESSION_COOKIE, SESSION_VALUE, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        signed: true,
        maxAge: SESSION_MAX_AGE,
        secure: config.PUBLIC_BASE_URL.startsWith('https://'),
      })
      .redirect('/');
  });

  app.get('/logout', async (_req, reply) => {
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).redirect('/login');
  });
}
