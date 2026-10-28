import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { mailAccountRequestSchema, mailDraftSchema, mailKeyImportSchema } from '@elvis/shared';
import type { MailService } from '../services/mail.js';
import { idParam, operatorOf, parse } from './util.js';

const folderQuery = z.object({ folder: z.enum(['inbox', 'sent']).default('inbox') });
const seenBody = z.object({ seen: z.boolean() });
const recipientsBody = z.object({ addresses: z.array(z.string().max(254)).max(50) });
const addressParam = z.object({ address: z.string().trim().toLowerCase().email() });

/** Content-Disposition mit Umlauten (RFC 6266) */
const disposition = (kind: 'inline' | 'attachment', filename: string) =>
  `${kind}; filename="${filename.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`;

/** E-Mail: Postfach beantragen/kündigen (Admins, /api/system/…), lesen und senden (alle Angemeldeten) */
export function mailRoutes(app: FastifyInstance, mail: MailService): void {
  app.get('/api/system/mail', async () => mail.refresh());
  app.post('/api/system/mail', async (req, reply) => reply.code(201).send(await mail.request(parse(mailAccountRequestSchema, req.body), operatorOf(req))));
  app.delete('/api/system/mail', async (req, reply) => {
    await mail.cancel(operatorOf(req));
    return reply.code(204).send();
  });

  app.get('/api/mail/available', async () => mail.available());
  app.get('/api/mail/unread', async () => ({ count: mail.unread() }));
  app.get('/api/mail/messages', async (req) => mail.list(parse(folderQuery, req.query).folder));
  app.get('/api/mail/messages/:id', async (req) => mail.message(parse(idParam, req.params).id));
  app.get('/api/mail/messages/:id/raw', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    return reply.header('content-type', 'message/rfc822').header('content-disposition', disposition('attachment', `mail-${id}.eml`)).send(mail.raw(id));
  });
  app.post('/api/mail/messages/:id/seen', async (req, reply) => {
    mail.setSeen(parse(idParam, req.params).id, parse(seenBody, req.body).seen);
    return reply.code(204).send();
  });
  app.delete('/api/mail/messages/:id', async (req, reply) => {
    mail.remove(parse(idParam, req.params).id, operatorOf(req));
    return reply.code(204).send();
  });
  app.get('/api/mail/attachments/:id', async (req, reply) => {
    const a = mail.attachment(parse(idParam, req.params).id);
    // Anhänge nie im Kontext von ELVIS ausführen
    return reply
      .header('content-type', a.contentType)
      .header('content-disposition', disposition('attachment', a.filename))
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(a.content);
  });

  app.post('/api/mail/send', { bodyLimit: 25 * 1024 * 1024 }, async (req, reply) => reply.code(201).send(await mail.send(parse(mailDraftSchema, req.body), operatorOf(req))));
  app.post('/api/mail/recipients', async (req) => mail.recipients(parse(recipientsBody, req.body).addresses));

  app.get('/api/mail/keys', async () => mail.keys());
  app.post('/api/mail/keys', async (req, reply) => reply.code(201).send(await mail.importKey(parse(mailKeyImportSchema, req.body).publicKey, operatorOf(req))));
  app.delete('/api/mail/keys/:address', async (req, reply) => {
    mail.removeKey(parse(addressParam, req.params).address, operatorOf(req));
    return reply.code(204).send();
  });
}
