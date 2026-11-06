'use strict';

// Harnais de test de `scripts/lib/traduction.js`.
//
// Node pur, bibliothèque standard uniquement (`node:test`, `node:assert`),
// CommonJS, aucune dépendance npm. Lancement :
//
//   node test/traduction.test.js
//
// Test UNITAIRE, sur la même forme que `test/texte.test.js` : `require` direct du
// module, sans réseau ni sous-processus. Le proxy réel est exercé par
// `test/proxy.test.js`.
//
// Ce qui compte ici n'est pas la couverture des champs, mais les écarts de FORME
// entre les deux API, parce que ce sont eux qui cassent une session Claude Code sans
// message clair : un `tool_result` mal placé, un `role: "system"` refusé par le
// gabarit du modèle, un bloc de flux ouvert avant que le précédent soit fermé.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  requeteVersOpenAI,
  reponseVersAnthropic,
  creerTraducteurFlux,
  erreurVersAnthropic,
} = require(path.resolve(__dirname, '..', 'scripts', 'lib', 'traduction.js'));

const MODELE = 'qwen-essai';
const traduire = (corps, options = {}) => requeteVersOpenAI(corps, { modele: MODELE, ...options });

/**
 * Invariants d'une séquence d'événements Anthropic : `message_start` en tête,
 * `message_delta` puis `message_stop` en queue, et des blocs séquentiels — chacun
 * fermé avant l'ouverture du suivant, aux index 0, 1, 2…
 */
function verifierSequence(evenements) {
  assert.equal(evenements[0].type, 'message_start');
  assert.equal(evenements.at(-2).type, 'message_delta');
  assert.equal(evenements.at(-1).type, 'message_stop');
  let ouvert = null;
  let attendu = 0;
  for (const e of evenements) {
    if (e.type === 'content_block_start') {
      assert.equal(ouvert, null, `bloc ${e.index} ouvert alors que ${ouvert} ne l'est pas fermé`);
      assert.equal(e.index, attendu);
      ouvert = e.index;
    } else if (e.type === 'content_block_delta') {
      assert.equal(e.index, ouvert, 'delta hors du bloc ouvert');
    } else if (e.type === 'content_block_stop') {
      assert.equal(e.index, ouvert);
      ouvert = null;
      attendu += 1;
    }
  }
  assert.equal(ouvert, null, 'un bloc reste ouvert en fin de message');
}

const blocsDe = (evenements) => evenements
  .filter((e) => e.type === 'content_block_start')
  .map((e) => e.content_block);

const texteDuFlux = (evenements) => evenements
  .filter((e) => e.type === 'content_block_delta' && e.delta.type === 'text_delta')
  .map((e) => e.delta.text)
  .join('');

// ═════════════════════════════════════════════════════════════════════════════
// requeteVersOpenAI
// ═════════════════════════════════════════════════════════════════════════════

test('le modèle amont est imposé, celui du client n’est jamais transmis', () => {
  const sortie = traduire({ model: 'claude-opus-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(sortie.model, MODELE);
  assert.throws(() => requeteVersOpenAI({ messages: [] }, {}), /modèle amont absent/);
});

test('system, en chaîne ou en blocs, devient le premier message system', () => {
  for (const system of ['Tu es utile.', [{ type: 'text', text: 'Tu es', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'utile.' }]]) {
    const sortie = traduire({ system, messages: [{ role: 'user', content: 'bonjour' }] });
    assert.equal(sortie.messages[0].role, 'system');
    assert.match(sortie.messages[0].content, /Tu es[\s\S]*utile\./);
    assert.deepEqual(sortie.messages[1], { role: 'user', content: 'bonjour' });
  }
});

test('deux messages user consécutifs sont fusionnés — certains gabarits exigent l’alternance', () => {
  const sortie = traduire({
    messages: [
      { role: 'user', content: 'un' },
      { role: 'user', content: [{ type: 'text', text: 'deux' }] },
    ],
  });
  assert.equal(sortie.messages.length, 1);
  assert.equal(sortie.messages[0].content, 'un\n\ndeux');
});

test('tool_use devient tool_calls, et tool_result un message tool placé juste après l’assistant', () => {
  const sortie = traduire({
    messages: [
      { role: 'user', content: 'lis le fichier' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'secret', signature: 'abc' },
          { type: 'text', text: 'Je lis.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a' } },
          { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/b' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'contenu a' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'introuvable' }], is_error: true },
          { type: 'text', text: 'et maintenant ?' },
        ],
      },
    ],
  });
  const [, assistant, outil1, outil2, suite] = sortie.messages;
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.content, 'Je lis.', 'le bloc thinking doit disparaître');
  assert.deepEqual(assistant.tool_calls.map((a) => [a.id, a.function.name, JSON.parse(a.function.arguments)]), [
    ['toolu_1', 'Read', { file_path: '/a' }],
    ['toolu_2', 'Read', { file_path: '/b' }],
  ]);
  assert.deepEqual(outil1, { role: 'tool', tool_call_id: 'toolu_1', content: 'contenu a' });
  assert.equal(outil2.role, 'tool');
  assert.match(outil2.content, /^\[ERREUR DE L'OUTIL\]\nintrouvable$/);
  assert.deepEqual(suite, { role: 'user', content: 'et maintenant ?' });
});

test('un assistant qui n’émet que des appels d’outils a un content null', () => {
  const sortie = traduire({
    messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] },
    ],
  });
  assert.equal(sortie.messages[1].content, null);
  assert.equal(sortie.messages[1].tool_calls[0].function.arguments, '{}');
});

test('une image de tool_result repart dans un message user après les messages tool', () => {
  const sortie = traduire({
    messages: [
      { role: 'user', content: 'regarde' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 't',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
        }],
      },
    ],
  });
  const [, , outil, utilisateur] = sortie.messages;
  assert.equal(outil.role, 'tool');
  assert.match(outil.content, /image jointe/);
  assert.equal(utilisateur.role, 'user');
  assert.deepEqual(utilisateur.content, [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
});

test('un role system en cours de conversation est versé dans le message user suivant', () => {
  const sortie = traduire({
    system: 'tête',
    messages: [
      { role: 'user', content: 'un' },
      { role: 'assistant', content: 'réponse' },
      { role: 'system', content: [{ type: 'text', text: 'rappel', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: 'deux' },
    ],
  });
  assert.deepEqual(sortie.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(sortie.messages[3].content, 'rappel\n\ndeux');
});

test('un role system juste avant l’assistant se pose sur le dernier user, sans casser l’alternance', () => {
  const sortie = traduire({
    messages: [
      { role: 'user', content: 'un' },
      { role: 'system', content: 'rappel' },
      { role: 'assistant', content: 'réponse' },
    ],
  });
  assert.deepEqual(sortie.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(sortie.messages[0].content, 'un\n\nrappel');
});

test('un role system en fin de conversation devient le dernier message user', () => {
  const sortie = traduire({
    messages: [
      { role: 'user', content: 'un' },
      { role: 'assistant', content: 'réponse' },
      { role: 'system', content: 'rappel final' },
    ],
  });
  assert.deepEqual(sortie.messages.at(-1), { role: 'user', content: 'rappel final' });
});

test('un role system entre tool_use et tool_result ne s’intercale pas entre l’assistant et ses tool', () => {
  const sortie = traduire({
    messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] },
      { role: 'system', content: 'rappel' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
    ],
  });
  assert.deepEqual(sortie.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'user']);
  assert.equal(sortie.messages[3].content, 'rappel');
});

test('les outils serveur sans input_schema sont retirés, tool_choice est traduit', () => {
  const corps = {
    messages: [{ role: 'user', content: 'x' }],
    tools: [
      { name: 'Bash', description: 'shell', input_schema: { type: 'object', properties: {} }, cache_control: { type: 'ephemeral' } },
      { type: 'web_search_20250305', name: 'web_search' },
    ],
  };
  const sortie = traduire({ ...corps, tool_choice: { type: 'any', disable_parallel_tool_use: true } });
  assert.deepEqual(sortie.tools, [{
    type: 'function',
    function: { name: 'Bash', description: 'shell', parameters: { type: 'object', properties: {} } },
  }]);
  assert.equal(sortie.tool_choice, 'required');
  assert.equal(sortie.parallel_tool_calls, false);
  assert.deepEqual(traduire({ ...corps, tool_choice: { type: 'tool', name: 'Bash' } }).tool_choice, {
    type: 'function', function: { name: 'Bash' },
  });
  assert.equal(traduire({ ...corps, tool_choice: { type: 'none' } }).tool_choice, 'none');
  assert.equal(traduire({ messages: corps.messages, tools: [corps.tools[1]] }).tools, undefined);
});

test('max_tokens est borné par le plafond, et le plafond s’applique quand il manque', () => {
  const messages = [{ role: 'user', content: 'x' }];
  assert.equal(traduire({ messages, max_tokens: 64000 }, { plafondMaxTokens: 8192 }).max_tokens, 8192);
  assert.equal(traduire({ messages, max_tokens: 100 }, { plafondMaxTokens: 8192 }).max_tokens, 100);
  assert.equal(traduire({ messages }, { plafondMaxTokens: 8192 }).max_tokens, 8192);
});

test('les champs sans équivalent OpenAI sont ignorés, les paramètres d’échantillonnage passent', () => {
  const sortie = traduire({
    messages: [{ role: 'user', content: 'x' }],
    thinking: { type: 'adaptive' },
    context_management: { edits: [] },
    output_config: { effort: 'high' },
    metadata: { user_id: 'u' },
    temperature: 0.2,
    top_p: 0.9,
    top_k: 5,
    stop_sequences: ['FIN'],
    stream: true,
  });
  for (const champ of ['thinking', 'context_management', 'output_config', 'metadata', 'top_k']) {
    assert.equal(champ in sortie, false, `${champ} ne doit pas partir vers l’amont`);
  }
  assert.equal(sortie.temperature, 0.2);
  assert.equal(sortie.top_p, 0.9);
  assert.deepEqual(sortie.stop, ['FIN']);
  assert.equal(sortie.stream, true);
  assert.deepEqual(sortie.stream_options, { include_usage: true });
});

// ═════════════════════════════════════════════════════════════════════════════
// reponseVersAnthropic
// ═════════════════════════════════════════════════════════════════════════════

test('une réponse texte devient un message Anthropic, modèle demandé conservé', () => {
  const sortie = reponseVersAnthropic({
    choices: [{ message: { role: 'assistant', content: 'Bonjour' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 12, completion_tokens: 3 },
  }, 'claude-opus-5-5');
  assert.equal(sortie.type, 'message');
  assert.equal(sortie.role, 'assistant');
  assert.equal(sortie.model, 'claude-opus-5-5');
  assert.deepEqual(sortie.content, [{ type: 'text', text: 'Bonjour' }]);
  assert.equal(sortie.stop_reason, 'max_tokens');
  assert.deepEqual(sortie.usage, { input_tokens: 12, output_tokens: 3 });
  assert.match(sortie.id, /^msg_/);
});

test('des appels d’outils donnent stop_reason tool_use, même si l’amont dit stop', () => {
  const sortie = reponseVersAnthropic({
    choices: [{
      message: {
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/a"}' } },
          { id: 'call_2', type: 'function', function: { name: 'Bash', arguments: '{pas du json' } },
        ],
      },
      finish_reason: 'stop',
    }],
  }, 'm');
  assert.equal(sortie.stop_reason, 'tool_use');
  assert.deepEqual(sortie.content, [
    { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: '/a' } },
    { type: 'tool_use', id: 'call_2', name: 'Bash', input: {} },
  ]);
  assert.deepEqual(sortie.usage, { input_tokens: 0, output_tokens: 0 });
});

// ═════════════════════════════════════════════════════════════════════════════
// creerTraducteurFlux
// ═════════════════════════════════════════════════════════════════════════════

function derouler(morceaux, modele = 'm') {
  const traducteur = creerTraducteurFlux(modele);
  const evenements = [];
  for (const m of morceaux) evenements.push(...traducteur.morceau(m));
  evenements.push(...traducteur.fin());
  return evenements;
}

test('un flux de texte donne la séquence Anthropic complète, usage du dernier morceau', () => {
  const evenements = derouler([
    { choices: [{ delta: { role: 'assistant', content: '' } }] },
    { choices: [{ delta: { content: 'Bon' } }], usage: { prompt_tokens: 9, completion_tokens: 1 } },
    { choices: [{ delta: { reasoning_content: 'je réfléchis' } }] },
    { choices: [{ delta: { content: 'jour' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 2 } },
  ], 'claude-x');
  verifierSequence(evenements);
  assert.equal(evenements[0].message.model, 'claude-x');
  assert.equal(texteDuFlux(evenements), 'Bonjour', 'le raisonnement ne doit pas fuir dans le texte');
  assert.deepEqual(blocsDe(evenements), [{ type: 'text', text: '' }]);
  const delta = evenements.at(-2);
  assert.equal(delta.delta.stop_reason, 'end_turn');
  assert.deepEqual(delta.usage, { input_tokens: 9, output_tokens: 2 });
});

test('des appels d’outils entrelacés par index deviennent des blocs séquentiels après le texte', () => {
  const evenements = derouler([
    { choices: [{ delta: { content: 'Je lance deux outils.' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'Read', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'Bash', arguments: '{"comm' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"file_path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: 'and":"npm test"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"/a"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  verifierSequence(evenements);
  assert.deepEqual(blocsDe(evenements), [
    { type: 'text', text: '' },
    { type: 'tool_use', id: 'call_a', name: 'Read', input: {} },
    { type: 'tool_use', id: 'call_b', name: 'Bash', input: {} },
  ]);
  const json = evenements
    .filter((e) => e.type === 'content_block_delta' && e.delta.type === 'input_json_delta')
    .map((e) => JSON.parse(e.delta.partial_json));
  assert.deepEqual(json, [{ file_path: '/a' }, { command: 'npm test' }]);
  assert.equal(evenements.at(-2).delta.stop_reason, 'tool_use');
});

test('un appel d’outil livré en un seul morceau, sans id, reçoit un id généré', () => {
  const evenements = derouler([
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'Bash', arguments: '{"command":"ls"}' } }] }, finish_reason: 'stop' }] },
  ]);
  verifierSequence(evenements);
  const [bloc] = blocsDe(evenements);
  assert.match(bloc.id, /^toolu_/);
  assert.equal(evenements.at(-2).delta.stop_reason, 'tool_use');
});

test('un flux vide reste une séquence valide, et rien ne sort après fin()', () => {
  const traducteur = creerTraducteurFlux('m');
  const evenements = traducteur.fin();
  verifierSequence(evenements);
  assert.equal(traducteur.termine, true);
  assert.deepEqual(traducteur.morceau({ choices: [{ delta: { content: 'tard' } }] }), []);
  assert.deepEqual(traducteur.fin(), []);
});

// ═════════════════════════════════════════════════════════════════════════════
// erreurVersAnthropic
// ═════════════════════════════════════════════════════════════════════════════

test('le message d’erreur amont est extrait du JSON et recopié sans réécriture', () => {
  assert.deepEqual(
    erreurVersAnthropic(400, JSON.stringify({ error: { message: 'Unexpected role "system"', type: 'BadRequest' } })),
    { type: 'error', error: { type: 'invalid_request_error', message: 'Unexpected role "system"' } },
  );
  assert.equal(erreurVersAnthropic(422, JSON.stringify({ detail: 'champ inconnu' })).error.message, 'champ inconnu');
  assert.equal(erreurVersAnthropic(502, '<html>bad gateway</html>').error.message, '<html>bad gateway</html>');
  assert.equal(erreurVersAnthropic(500, '').error.message, 'erreur amont HTTP 500');
});

test('le type d’erreur suit le statut HTTP', () => {
  const type = (statut) => erreurVersAnthropic(statut, '{}').error.type;
  assert.equal(type(401), 'authentication_error');
  assert.equal(type(429), 'rate_limit_error');
  assert.equal(type(503), 'overloaded_error');
  assert.equal(type(500), 'api_error');
  assert.equal(type(504), 'api_error');
  assert.equal(type(418), 'invalid_request_error');
});
