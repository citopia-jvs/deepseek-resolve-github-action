'use strict';

// Harnais de test de `scripts/proxy.js`.
//
// Node pur, bibliothèque standard uniquement (`node:test`, `node:assert`),
// CommonJS, aucune dépendance npm. Lancement :
//
//   node test/proxy.test.js
//
// Test d'INTÉGRATION, hors ligne : un faux amont OpenAI (`node:http`) tourne dans ce
// processus, et le proxy est lancé en sous-processus sur `PROXY_PORT=0`, exactement
// comme le lancera un step d'action. Aucune clé réelle, aucun réseau au-delà de
// 127.0.0.1.
//
// La traduction des corps est couverte par `test/traduction.test.js`. Ici, on vérifie
// ce que seul le proxy en marche peut montrer : l'authentification, le relais SSE
// sans mise en tampon, les `ping`, la coupure du flux amont, le passage du
// `retry-after`, et que la clé amont ne sort jamais — ni vers le client, ni au journal.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const PROXY = path.resolve(__dirname, '..', 'scripts', 'proxy.js');
const CLE_AMONT = 'cle-amont-0123456789-ne-doit-jamais-sortir';
const JETON = 'jeton-du-proxy-pour-les-tests';
const MODELE = 'qwen-essai';

let amont;
let portAmont;
let proxy;
let urlProxy;
let journal = '';
let repertoire;
// Le comportement du faux amont, posé par chaque test.
let scenario = null;
const recues = [];

function demarrerAmont() {
  return new Promise((resoudre) => {
    amont = http.createServer((req, res) => {
      let corps = '';
      req.on('data', (m) => { corps += m; });
      req.on('end', () => {
        recues.push({ url: req.url, entetes: req.headers, corps: corps ? JSON.parse(corps) : null });
        scenario(req, res);
      });
    });
    amont.listen(0, '127.0.0.1', () => resoudre(amont.address().port));
  });
}

function environnementProxy(supplement = {}) {
  return {
    PATH: process.env.PATH,
    SCW_MODELE: MODELE,
    SCW_BASE_URL: `http://127.0.0.1:${portAmont}/v1`,
    SCW_CLE_FICHIER: path.join(repertoire, 'cle'),
    PROXY_JETON: JETON,
    PROXY_PORT: '0',
    INTERVALLE_PING_MS: '50',
    ...supplement,
  };
}

before(async () => {
  repertoire = fs.mkdtempSync(path.join(os.tmpdir(), 'dsr-proxy-'));
  fs.writeFileSync(path.join(repertoire, 'cle'), `${CLE_AMONT}\n`, { mode: 0o600 });
  portAmont = await demarrerAmont();
  proxy = spawn(process.execPath, [PROXY], { env: environnementProxy(), stdio: ['ignore', 'pipe', 'pipe'] });
  proxy.stderr.on('data', (m) => { journal += m; });
  const port = await new Promise((resoudre, rejeter) => {
    let sortie = '';
    proxy.stdout.on('data', (m) => {
      sortie += m;
      const trouve = /^PORT=(\d+)$/m.exec(sortie);
      if (trouve) resoudre(Number(trouve[1]));
    });
    proxy.on('exit', (code) => rejeter(new Error(`proxy mort au démarrage (${code}) : ${journal}`)));
  });
  urlProxy = `http://127.0.0.1:${port}`;
});

after(() => {
  proxy.kill('SIGTERM');
  amont.close();
  fs.rmSync(repertoire, { recursive: true, force: true });
});

const entetesClient = (supplement = {}) => ({
  'content-type': 'application/json',
  'x-api-key': JETON,
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'context-management-2025-06-27',
  ...supplement,
});

const corpsMinimal = (supplement = {}) => JSON.stringify({
  model: 'claude-opus-5-5',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'bonjour' }],
  ...supplement,
});

/** Écrit un flux SSE OpenAI, un morceau à la fois, avec une pause entre chaque. */
function fluxOpenAI(res, morceaux, { pauseMs = 0, terminer = true } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let i = 0;
  const suivant = () => {
    if (i < morceaux.length) {
      res.write(`data: ${JSON.stringify(morceaux[i])}\n\n`);
      i += 1;
      setTimeout(suivant, pauseMs);
      return;
    }
    if (terminer) res.write('data: [DONE]\n\n');
    res.end();
  };
  suivant();
}

function lireSSE(texte) {
  return texte.split('\n\n').filter(Boolean).map((bloc) => {
    const evenement = /^event: (.+)$/m.exec(bloc)[1];
    const donnees = JSON.parse(/^data: (.+)$/m.exec(bloc)[1]);
    assert.equal(donnees.type, evenement, 'le nom SSE et le type doivent coïncider');
    return donnees;
  });
}

// ═════════════════════════════════════════════════════════════════════════════

test('HEAD /api/hello répond 200 sans jeton — la sonde de démarrage de Claude Code', async () => {
  const reponse = await fetch(`${urlProxy}/api/hello`, { method: 'HEAD' });
  assert.equal(reponse.status, 200);
});

test('sans jeton ou avec un mauvais jeton : 401, et l’amont n’est jamais appelé', async () => {
  const avant = recues.length;
  scenario = () => assert.fail('l’amont ne doit pas être appelé');
  for (const entetes of [{ 'x-api-key': '' }, { 'x-api-key': 'faux' }, { 'x-api-key': '', authorization: 'Bearer faux' }]) {
    const reponse = await fetch(`${urlProxy}/v1/messages`, { method: 'POST', headers: entetesClient(entetes), body: corpsMinimal() });
    assert.equal(reponse.status, 401);
    assert.equal((await reponse.json()).error.type, 'authentication_error');
  }
  assert.equal(recues.length, avant);
});

test('requête sans flux : modèle imposé, clé amont en Bearer, réponse traduite', async () => {
  scenario = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: 'Salut' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    }));
  };
  // `?beta=true` : Claude Code l'ajoute, la route se décide sur le chemin seul.
  const reponse = await fetch(`${urlProxy}/v1/messages?beta=true`, {
    method: 'POST',
    headers: entetesClient({ 'x-api-key': '', authorization: `Bearer ${JETON}` }),
    body: corpsMinimal(),
  });
  assert.equal(reponse.status, 200);
  const message = await reponse.json();
  assert.equal(message.model, 'claude-opus-5-5');
  assert.deepEqual(message.content, [{ type: 'text', text: 'Salut' }]);
  assert.deepEqual(message.usage, { input_tokens: 5, output_tokens: 1 });

  const recue = recues.at(-1);
  assert.equal(recue.url, '/v1/chat/completions');
  assert.equal(recue.entetes.authorization, `Bearer ${CLE_AMONT}`);
  assert.equal(recue.corps.model, MODELE);
  assert.equal('anthropic-beta' in recue.entetes, false, 'les en-têtes Anthropic ne partent pas vers l’amont');
});

test('requête en flux : SSE relayé, pings pendant les silences, séquence complète', async () => {
  scenario = (req, res) => fluxOpenAI(res, [
    { choices: [{ delta: { content: 'Je ' } }] },
    { choices: [{ delta: { content: 'lance.' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Bash', arguments: '{"command":"npm test"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 7 } },
  ], { pauseMs: 150 });
  const reponse = await fetch(`${urlProxy}/v1/messages`, {
    method: 'POST',
    headers: entetesClient(),
    body: corpsMinimal({ stream: true }),
  });
  assert.equal(reponse.status, 200);
  assert.match(reponse.headers.get('content-type'), /^text\/event-stream/);
  const evenements = lireSSE(await reponse.text());
  assert.ok(evenements.some((e) => e.type === 'ping'), 'un ping doit couvrir les pauses de l’amont');
  const utiles = evenements.filter((e) => e.type !== 'ping');
  assert.equal(utiles[0].type, 'message_start');
  assert.deepEqual(utiles.slice(-2).map((e) => e.type), ['message_delta', 'message_stop']);
  assert.equal(utiles.at(-2).delta.stop_reason, 'tool_use');
  assert.deepEqual(utiles.at(-2).usage, { input_tokens: 20, output_tokens: 7 });
  const outil = utiles.find((e) => e.type === 'content_block_start' && e.content_block.type === 'tool_use');
  assert.equal(outil.content_block.name, 'Bash');
  assert.equal(recues.at(-1).corps.stream, true);
});

test('un flux amont coupé avant [DONE] finit en événement error, jamais en message_stop', async () => {
  scenario = (req, res) => fluxOpenAI(res, [{ choices: [{ delta: { content: 'début' } }] }], { terminer: false });
  const reponse = await fetch(`${urlProxy}/v1/messages`, {
    method: 'POST',
    headers: entetesClient(),
    body: corpsMinimal({ stream: true }),
  });
  const evenements = lireSSE(await reponse.text());
  assert.equal(evenements.some((e) => e.type === 'message_stop'), false,
    'un message_stop inventé ferait passer une réponse tronquée pour complète');
  assert.equal(evenements.at(-1).type, 'error');
});

test('429 amont : statut, retry-after en secondes entières et x-should-retry conservés', async () => {
  scenario = (req, res) => {
    res.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': new Date(Date.now() + 30000).toUTCString(),
      'x-should-retry': 'true',
    });
    res.end(JSON.stringify({ error: { message: 'Rate limit exceeded' } }));
  };
  const reponse = await fetch(`${urlProxy}/v1/messages`, { method: 'POST', headers: entetesClient(), body: corpsMinimal() });
  assert.equal(reponse.status, 429);
  assert.match(reponse.headers.get('retry-after'), /^\d+$/);
  assert.ok(Number(reponse.headers.get('retry-after')) <= 31);
  assert.equal(reponse.headers.get('x-should-retry'), 'true');
  assert.deepEqual(await reponse.json(), {
    type: 'error',
    error: { type: 'rate_limit_error', message: 'Rate limit exceeded' },
  });
});

test('une erreur amont qui recopie la clé est masquée, vers le client comme au journal', async () => {
  scenario = (req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `clé refusée : ${req.headers.authorization}` } }));
  };
  const reponse = await fetch(`${urlProxy}/v1/messages`, { method: 'POST', headers: entetesClient(), body: corpsMinimal() });
  const texte = await reponse.text();
  assert.equal(reponse.status, 400);
  assert.equal(texte.includes(CLE_AMONT), false, 'la clé amont est partie vers le client');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(journal.includes(CLE_AMONT), false, 'la clé amont est partie au journal');
  assert.match(journal, /"statut":400/);
});

test('count_tokens, /v1/models et les routes inconnues : 404 au format Anthropic', async () => {
  for (const [methode, chemin] of [['POST', '/v1/messages/count_tokens'], ['GET', '/v1/models'], ['GET', '/']]) {
    const reponse = await fetch(`${urlProxy}${chemin}`, { method: methode, headers: entetesClient(), body: methode === 'POST' ? '{}' : undefined });
    assert.equal(reponse.status, 404);
    assert.equal((await reponse.json()).error.type, 'not_found_error');
  }
});

test('un corps JSON invalide : 400 invalid_request_error, sans appel amont', async () => {
  const avant = recues.length;
  const reponse = await fetch(`${urlProxy}/v1/messages`, { method: 'POST', headers: entetesClient(), body: '{pas du json' });
  assert.equal(reponse.status, 400);
  assert.equal((await reponse.json()).error.type, 'invalid_request_error');
  assert.equal(recues.length, avant);
});

test('le journal ne contient aucun corps de requête', () => {
  assert.equal(journal.includes('bonjour'), false);
  assert.match(journal, /"modeleDemande":"claude-opus-5-5"/);
  assert.match(journal, new RegExp(`"modeleAmont":"${MODELE}"`));
});

test('configuration incomplète : sortie 2 et message explicite, sans démarrer', () => {
  const cas = [
    [{ SCW_MODELE: '' }, /SCW_MODELE est obligatoire/],
    [{ PROXY_JETON: '' }, /PROXY_JETON est obligatoire/],
    [{ SCW_CLE_FICHIER: '' }, /SCW_CLE_FICHIER est obligatoire/],
    [{ SCW_CLE_FICHIER: path.join(repertoire, 'absent') }, /lecture de SCW_CLE_FICHIER impossible : ENOENT/],
    [{ PROXY_PORT: 'abc' }, /PROXY_PORT doit être un entier/],
  ];
  for (const [supplement, motif] of cas) {
    const resultat = spawnSync(process.execPath, [PROXY], { env: environnementProxy(supplement), encoding: 'utf8', timeout: 5000 });
    assert.equal(resultat.status, 2, `${JSON.stringify(supplement)} : ${resultat.stderr}`);
    assert.match(resultat.stderr, motif);
  }
});
