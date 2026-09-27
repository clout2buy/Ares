import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startFamilyReplies } from '../packages/cli/dist/entry/familyWiring.js';
import { rolloutPath } from '../packages/garrison/dist/sessions.js';

test('a human reply wakes only the prior named agent and delivers once', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'family-reply-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const records = [
    { id: '1', from: 'noah', to: 'jamara', sender: 'Benny', text: 'How are you?', mode: 'private', threadId: 'family-1' },
    { id: '2', from: 'jamara', to: 'noah', sender: 'Jamara', text: 'I am okay', mode: 'private', threadId: 'family-1' },
  ];
  const sent = [];
  const pushes = [];
  const prompts = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (_, options) => {
    if (options.method === 'POST') { const body = JSON.parse(options.body); sent.push(body); records.push({ ...body, id: String(records.length + 1), from: 'noah' }); return { ok: true }; }
    return { ok: true, json: async () => ({ messages: structuredClone(records) }) };
  };
  t.after(() => { globalThis.fetch = previous; });
  const sessionId = 'sess_benny';
  const stop = startFamilyReplies({ home, relay: 'http://family.test', token: 'test', self: 'noah',
    store: { list: () => [{ name: 'Health Major Benny', sessionId }] },
    sessions: { send: async (id, text) => {
      assert.equal(id, sessionId);
      prompts.push(text);
      assert.match(text, /Jamara.*I am okay/);
      const file = rolloutPath(home, id);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ ts: new Date().toISOString(), event: { type: 'message_done', message: { role: 'assistant', content: [{ type: 'text', text: 'Glad to hear it.' }] } } }) + '\n');
    }, flush: async () => {} },
    push: async (message) => { pushes.push(message); }, log: (line) => { throw Error(line); },
  });
  t.after(stop);
  for (let i = 0; i < 100 && pushes.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Private update to your owner only/);
  assert.equal(pushes[0].data.kind, 'persona_message');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'jamara');
  assert.equal(sent[0].sender, 'Health Major Benny');
  assert.equal(sent[0].threadId, 'family-1');
  assert.equal(pushes.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(home, 'family-replies-cursor.json'), 'utf8')).id, '2');
});

test('an agent that sent its own answer is not duplicated by the worker', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'family-already-replied-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const records = [
    { id: '1', from: 'noah', to: 'jamara', sender: 'Benny', text: 'Hello', mode: 'private', threadId: 'family-1' },
    { id: '2', from: 'jamara', to: 'noah', sender: 'Jamara', text: 'Hi Benny', mode: 'private', threadId: 'family-1' },
    { id: '3', from: 'noah', to: 'jamara', sender: 'Benny', text: 'Hi back', mode: 'private', threadId: 'family-1' },
  ];
  let sent = 0;
  let notices = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async (_, options) => options.method === 'POST'
    ? (sent++, { ok: true }) : { ok: true, json: async () => ({ messages: records }) };
  t.after(() => { globalThis.fetch = previous; });
  const stop = startFamilyReplies({ home, relay: 'http://family.test', token: 'test', self: 'noah',
    store: { list: () => [{ name: 'Health Major Benny', sessionId: 'sess_benny' }] },
    sessions: { send: async (_, text) => { if (!text.includes('Private update to your owner only')) throw Error('must not reply twice'); notices++; }, flush: async () => {} },
    push: async () => {}, log: (line) => { throw Error(line); },
  });
  t.after(stop);
  for (let i = 0; i < 100; i++) {
    try { if (JSON.parse(await readFile(path.join(home, 'family-replies-cursor.json'), 'utf8')).id === '3') break; }
    catch { /* awaiting first poll */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(sent, 0);
  assert.equal(notices, 1);
});
