import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MESSENGER_IDS, chatDraftSchema, chatFromDocumentSchema, chatToDocumentSchema, isChatImage, chatSettingsSchema, messengerSetupSchema } from '@elvis/shared';
import { HttpError } from '../errors.js';
import type { ChatService } from '../services/chat.js';
import type { ContactService } from '../services/contacts.js';
import type { DocumentService } from '../services/documents.js';
import type { ReachabilityService } from '../services/reachability.js';
import { MAX_DOCUMENT_BYTES } from './documents.js';
import { actorOf, idParam, operatorOf, parse } from './util.js';

const folderQuery = z.object({ folder: z.enum(['inbox', 'sent']).default('inbox') });
const seenBody = z.object({ seen: z.boolean() });
const suggestQuery = z.object({ q: z.string().max(100).default('') });
const threadQuery = z.object({ key: z.string().trim().min(1).max(80) });
const fileParams = z.object({ fileId: z.string().regex(/^[0-9a-f]{32}$/) });
const checkBody = z.object({ numbers: z.array(z.string().trim().min(3).max(40)).max(20) });

/** Nachrichten (SMS und Messenger) für alle Angemeldeten; Kanalreihenfolge nur Admins */
export function chatRoutes(app: FastifyInstance, deps: { chat: ChatService; reachability: ReachabilityService; contacts: ContactService; documents: DocumentService }): void {
  const { chat, reachability } = deps;
  app.get('/api/chat/available', async () => chat.available());
  app.get('/api/chat/unread', async () => ({ count: chat.unread() }));
  app.get('/api/chat/messages', async (req) => chat.list(parse(folderQuery, req.query).folder));
  app.get('/api/chat/messages/:id', async (req) => chat.message(parse(idParam, req.params).id));
  app.get('/api/chat/threads', async () => chat.threads());
  app.get('/api/chat/thread', async (req) => chat.thread(parse(threadQuery, req.query).key));
  app.post('/api/chat/thread/seen', async (req) => ({ marked: chat.markThreadSeen(parse(threadQuery, req.body).key) }));
  app.delete('/api/chat/thread', async (req) => ({ removed: chat.removeThread(parse(threadQuery, req.query).key, operatorOf(req)) }));
  app.post('/api/chat/messages/:id/seen', async (req, reply) => {
    chat.setSeen(parse(idParam, req.params).id, parse(seenBody, req.body).seen);
    return reply.code(204).send();
  });
  app.delete('/api/chat/messages/:id', async (req, reply) => {
    chat.remove(parse(idParam, req.params).id, operatorOf(req));
    return reply.code(204).send();
  });
  // Bild einer Nachricht in die Dokumente einer Lage übernehmen (Eintrag im Einsatztagebuch schreibt die Dokumentverwaltung)
  app.post('/api/chat/messages/:id/document', async (req, reply) => {
    const input = parse(chatToDocumentSchema, req.body);
    const msg = chat.message(parse(idParam, req.params).id);
    if (!msg.attachment) throw new HttpError(400, 'Die Nachricht hat keinen Anhang');
    const file = chat.file(msg.attachment.id);
    const doc = await deps.documents.upload(
      input.incidentId,
      input.folderId,
      { filename: file.name, mimeType: file.mimeType, stream: createReadStream(file.path), description: input.description },
      actorOf(req),
      MAX_DOCUMENT_BYTES,
    );
    return reply.code(201).send(doc);
  });
  app.post('/api/chat/send', async (req, reply) => reply.code(202).send(chat.send(parse(chatDraftSchema, req.body), operatorOf(req)).messages));
  app.get('/api/chat/suggest', async (req) => deps.contacts.chatSuggestions(parse(suggestQuery, req.query).q));

  // Erreichbarkeit: Rufnummer → Kanäle; „check“ prüft weitere Rufnummern sofort (z. B. frei eingegebene Empfänger)
  app.get('/api/chat/reachability', async () => reachability.map());
  // WhatsApp: wer in den letzten 24 h geschrieben hat (sonst geht nur eine Vorlage)
  app.get('/api/chat/whatsapp-window', async () => Object.fromEntries(chat.whatsappWindow()));
  app.post('/api/chat/reachability/check', async (req) => {
    const { numbers } = parse(checkBody, req.body);
    await reachability.refresh(numbers);
    return reachability.map(numbers);
  });

  // Dokument aus der Dokumentverwaltung als Anhang übernehmen (Kopie; Anhänge vom eigenen Rechner gibt es nicht)
  app.post('/api/chat/files/from-document', async (req, reply) => {
    const doc = deps.documents.visibleDocument(parse(chatFromDocumentSchema, req.body).documentId, req.user?.id ?? null);
    return reply.code(201).send(await chat.fromDocument(doc, operatorOf(req)));
  });
  app.get('/api/chat/files/:fileId', async (req, reply) => {
    const f = chat.file(parse(fileParams, req.params).fileId);
    return reply
      .header('content-type', f.mimeType)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'")
      .header('cache-control', 'private, max-age=31536000, immutable')
      // Dateien (PDF, Office, auch HTML) nur herunterladen, nicht im Browser unter dieser Adresse öffnen
      .header('content-disposition', isChatImage(f.mimeType) ? 'inline' : `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`)
      .send(createReadStream(f.path));
  });

  // Einrichtung der Messenger (QR-Code, Bestätigungscode, Passwort) – nur Admins, Codes nicht im Bedienprotokoll
  const messengerParams = z.object({ id: z.enum(MESSENGER_IDS) });
  app.get('/api/system/messengers/:id/setup', async (req) => chat.setupInfo(parse(messengerParams, req.params).id));
  app.post('/api/system/messengers/:id/setup', async (req) => chat.setup(parse(messengerParams, req.params).id, parse(messengerSetupSchema, req.body), operatorOf(req)));

  app.get('/api/system/chat', async () => chat.settings());
  app.put('/api/system/chat', async (req) => chat.updateSettings(parse(chatSettingsSchema, req.body), operatorOf(req)));
}
