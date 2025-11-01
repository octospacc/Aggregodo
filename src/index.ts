import Fastify from 'fastify';
import { FastifyRequest } from 'fastify';
import view from '@fastify/view';
import nunjucks from 'nunjucks';
import { sequelize } from './db';
import { Feed } from './models/feed';
import { fastifySchedule } from '@fastify/schedule';
import { SimpleIntervalJob, AsyncTask } from 'toad-scheduler';
import Parser from 'rss-parser';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { WebSocket } from '@fastify/websocket';
import { Config } from './prefs';
import createError from '@fastify/error';
import { prepareFilesystem, parseBool, filterObject, hashString, slugifyUrl } from './util';
import { PATHS, ATOM_CONTENT_TYPE } from './data';
import cookie from '@fastify/cookie';
import { patchReaderContent } from './html-utils';
import { dumpIni } from './ini-support';
import { User } from './models/user';
import bcrypt from "bcryptjs";
import { broadcastMessage, canRegisterAdmin, entryToMarkdown, fetchAndParseFeed, findEntryForView, findFeedById, findFeedBySlug, getPrefs, getRawFeeds, getSession, getTemplateFeeds, hasSpecialFeatures, indexFeeds, log, LogLevel, makeEntriesForView, PaginatableSearchableRequest, patchViewFeed, replyView, resultize, updateAllFeeds, updateFeed, urlFor } from './features';

prepareFilesystem();

const NotFoundError = createError('NOT_FOUND', 'Page Not Found', 404);

export const feedParser: Parser<{}, {
  'media:group': any;
  'media:content': string;
  'media:thumbnail': string;
  'media:description': string;
  'content:encoded': string;
  'content:encodedSnippet': string;
}> = new Parser({ customFields: {
  item: ['media:group', 'media:content', 'media:thumbnail', 'media:description'],
} });

export const activeClients = new Set<WebSocket>();
export const feedUpdateLocks = new Set<number>();

const app = Fastify({
  maxParamLength: 1000, // by default request with very long paths are rejected
  logger: Config.Development,
  ...(Config.Development && { bodyLimit: 1024 * 1024 * 10 }), // allow big POST requests in dev mode, eg. in debug panel
})
.register(fastifySchedule)
.register(cookie)
.register(require('@fastify/formbody'))
.register(require('@fastify/websocket'))
.register(async fastify => {
  fastify.get('/ws', { websocket: true }, (socket, _req) => {
    activeClients.add(socket);
    broadcastMessage('CONNECTED');

    socket.on('close', () => {
      activeClients.delete(socket);
    });
  })
})
.register(view, {
  engine: { nunjucks },
  templates: path.join(__dirname, '../res/views'),
  options: {
    noCache: Config.Development,
    onConfigure: (env: nunjucks.Environment) => {
      env.addGlobal('Config', Config);
      env.addGlobal('urlFor', urlFor);
      env.addGlobal('slugifyUrl', slugifyUrl);
    },
  },
})
.register(fastifyStatic, {
  root: path.join(__dirname, '../public'),
})
.register(fastifyStatic, {
  root: PATHS.MEDIA_DIR,
  prefix: '/media/',
  decorateReply: false,
})
.addHook('onRequest', async (req, reply) => {
  // redirect requests that have trailing slash
  if (req.url.length > 1 && req.url.endsWith('/')) {
    reply.redirect(req.url.slice(0, -1));
  }
});

app.ready().then(async () => {
  await sequelize.sync();
  const job = new SimpleIntervalJob({ minutes: Config.UpdateInterval }, new AsyncTask(
    'update-feeds',
    async () => updateAllFeeds(),
    (err) => log(LogLevel.ERROR, 'Feeds update failed:', err),
  ));
  job.executeAsync();
  app.scheduler.addSimpleIntervalJob(job);
});

app.get('/', async (req: PaginatableSearchableRequest, reply) => {
  const feeds = await indexFeeds();
  return resultize(req, reply, 'index.njk', 'entries', makeEntriesForView({ feeds }), {
    feeds, feedsMap: await getTemplateFeeds(feeds as Feed[]),
  });
});

app.get('/feed/:feed', async (req: FastifyRequest<{ Params: { feed: string }, Querystring: PaginatableSearchableRequest['query'] }>, reply) => {
  const feeds = await indexFeeds();
  const feed = await findFeedBySlug(req.params.feed);
  if (feed) {
    return resultize(req, reply, 'index.njk', 'entries', makeEntriesForView({ feed, feeds }), {
      feed, feedIni: dumpIni({
        [feed.url]: filterObject((await getRawFeeds()).filter(item => item.url === feed.url)[0], ['url'], false),
      } as any),
      feeds, feedsMap: await getTemplateFeeds(feeds as Feed[]),
    });
  } else {
    throw NotFoundError();
  }
});

app.get('/entry/:entry', async (req: FastifyRequest<{ Params: { entry: string }, Querystring: { 'external-html': string } }>, reply) => {
  // TODO: this currently returns a positive response for entries that belong to disabled feeds; should the behavior be different?
  const feeds = await indexFeeds();
  const entry = await findEntryForView(req.params.entry);
  if (entry) {
    if (getPrefs(req).ReaderMode) {
      const extHtml = parseBool(req.query['external-html']) ?? getPrefs(req).ExternalHtml;
      if (extHtml && entry.html) {
        entry.html = patchReaderContent(entry.html);
      }
      const feed = patchViewFeed((await Feed.findOne({ where: { id: entry.feedId } }))!);
      return replyView(req, reply, 'entry.njk', { feed, feeds, feedsMap: await getTemplateFeeds(feeds as Feed[]), entry, extHtml });
    } else {
      return reply.redirect(entry.link!);
    }
  } else {
    throw NotFoundError();
  }
});

app.get('/atom', async (req: PaginatableSearchableRequest, reply) => {
  return resultize(req, reply, 'atom.njk', 'entries', makeEntriesForView(), { req }, ATOM_CONTENT_TYPE);
});

app.get('/feed/:feed/atom', async (req: FastifyRequest<{ Params: { feed: string }, Querystring: PaginatableSearchableRequest['query'] }>, reply) => {
  const feed = await findFeedBySlug(req.params.feed);
  if (feed) {
    return resultize(req, reply, 'atom.njk', 'entries', makeEntriesForView({ feed }), { feed, req }, ATOM_CONTENT_TYPE);
  } else {
    throw NotFoundError();
  }
});

app
.get('/access', async (req, reply) => {
  return (await getSession(req)
    ? reply.redirect('/')
    : reply.view('access.njk', { adminRegister: await canRegisterAdmin() }));
})
.post('/access', async (req: FastifyRequest<{ Body: { username: string, password: string, password2?: string, remember?: boolean, action?: string } }>, reply) => {
  if (req.body.action === 'logout') {
    return reply
      .setCookie('Session', '', { path: '/', httpOnly: true, sameSite: 'strict', expires: new Date(0) })
      .redirect('/');
  }
  const adminRegister = await canRegisterAdmin();
  let error = null;
  const { username, password, remember } = req.body;
  let user = await User.findOne({ where: { username } });
  if (!username || !password || (!user && password !== req.body.password2) || (user && !(await bcrypt.compare(hashString(password, 'sha256'), user.password)))) {
    error = 'Invalid username or password!';
  }
  if (!user && (adminRegister || Config.AllowRegistration)) {
    const hash = await bcrypt.hash(hashString(password, 'sha256'), await bcrypt.genSalt());
    user = await User.create({ username, password: hash, ...(adminRegister && { role: 'admin' }) });
  }
  if (user && !error) {
    let cookie = `${username}:${hashString(user.password, 'sha256')}`;
    if (remember) {
      cookie += `:${new Date().getTime()}`;
    }
    return reply
      .setCookie('Session', cookie, { path: '/', httpOnly: true, sameSite: 'strict', ...(remember && { maxAge: 60 * 60 * 24 * 365 }) })
      .redirect('/');
  } else {
    return reply.view('access.njk', { error, adminRegister });
  }
});

app
.get('/debug', async (req, reply) => {
  if (!await hasSpecialFeatures({ req })) {
    throw NotFoundError();
  }
  return replyView(req, reply, 'debug.njk', { feeds: await indexFeeds(true) });
})
.post('/debug', async (req) => {
  if (!await hasSpecialFeatures({ req })) {
    throw NotFoundError();
  }
  let output;
  const input = JSON.parse(req.body as string);
  if (input.action) {
    let forceUpdateFeed = false;
    switch (input.action) {
      case 'force-update-feed':
        forceUpdateFeed = true;
      case 'update-feed':
        input.data
          ? updateFeed((await findFeedById(input.data))!, true, forceUpdateFeed)
          : updateAllFeeds(forceUpdateFeed);
        return 'OK';
    }
  } else if (input.ini) {
    const feed = (await getRawFeeds(input.ini))[0];
    output = feed;
  } else if (input.feed) {
    const { parsed, response, error } = await fetchAndParseFeed(input.feed, input.httpBody, true, true);
    output = { parsed, error, text: response?.data };
  }
  return output;
});

app.get('/entry/:entry/markdown', async (req: FastifyRequest<{ Params: { entry: string } }>, reply) => {
  if (!await hasSpecialFeatures({ req })) {
    throw NotFoundError();
  }
  const entry = await findEntryForView(req.params.entry);
  if (entry) {
    return reply
      .header('X-Robots-Tag', 'noindex')
      .type('text/markdown; charset=utf-8')
      .send(entryToMarkdown(entry));
  } else {
    throw NotFoundError();
  }
});

app.post('*', (req, reply) => {
  const { action, dkey, dvalue } = req.body as { action: string; dkey: string; dvalue: string; };
  if (action === 'set-prefs') {
    const prefs = getPrefs(req, false) as any;
    prefs[dkey] = dvalue;
    reply.setCookie('Prefs', JSON.stringify(prefs), { path: '/', maxAge: 60 * 60 * 24 * 365 * 100 });
  }
  reply.redirect(req.url);
});

app
.setNotFoundHandler((_req, reply) => {
  reply
    .code(404)
    .header('X-Robots-Tag', 'noindex')
    .view('error.njk', { code: 404, message: 'Page Not Found' });
})
.setErrorHandler((err, _req, reply) => {
  const code = err.statusCode || 500;
  reply
    .code(code)
    .header('X-Robots-Tag', 'noindex')
    .view('error.njk', { code, message: code === 500 ? 'Internal Server Error' : err.message });
  if (code !== 404) {
    log(LogLevel.ERROR, err);
  }
})
.listen({ port: Config.Http.Port, host: Config.Http.Host }, () => {
  log(LogLevel.INFO, `${Config.AppName} running at http://${Config.Http.Host}:${Config.Http.Port}`);
});