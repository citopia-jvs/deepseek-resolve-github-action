'use strict';

// Traduction Anthropic Messages ↔ OpenAI Chat Completions.
//
// Claude Code ne parle que le format Anthropic Messages ; Scaleway Generative APIs
// n'expose que le format OpenAI. Ce module fait le pont, sans réseau : fonctions
// pures, appelées par `scripts/proxy.js` et exercées seules par
// `test/traduction.test.js`.
//
// Bibliothèque standard uniquement, CommonJS : aucune dépendance. C'est la raison
// d'être de ce fichier — LiteLLM faisait le même travail, mais il aurait tourné à côté
// de la clé Scaleway et du `GITHUB_TOKEN`, après une attaque de sa chaîne
// d'approvisionnement en mars 2026 (GHSA-5mg7-485q-xm76).
//
// Ce qui est ignoré sans erreur, faute d'équivalent OpenAI : `thinking`,
// `context_management`, `output_config`, `cache_control`, `metadata`, `top_k`, les
// blocs `thinking` de l'historique et les outils « serveur » d'Anthropic (sans
// `input_schema`). Le contrat de Claude Code tolère leur absence : voir
// code.claude.com/docs/en/llm-gateway-protocol, « Feature pass-through ».

const crypto = require('node:crypto');

const PLAFOND_MAX_TOKENS_PAR_DEFAUT = 16384;

const STOP_REASON = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'refusal',
};

const TYPE_ERREUR_PAR_STATUT = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  503: 'overloaded_error',
  529: 'overloaded_error',
};

function identifiant(prefixe) {
  return `${prefixe}_${crypto.randomBytes(12).toString('hex')}`;
}

/** Texte d'un contenu Anthropic, chaîne ou liste de blocs : seuls les blocs `text` comptent. */
function texteDe(contenu) {
  if (typeof contenu === 'string') return contenu;
  if (!Array.isArray(contenu)) return '';
  return contenu
    .filter((bloc) => bloc && bloc.type === 'text' && typeof bloc.text === 'string')
    .map((bloc) => bloc.text)
    .join('\n\n');
}

function imageVersOpenAI(bloc) {
  const source = bloc.source || {};
  if (source.type === 'base64') {
    return { type: 'image_url', image_url: { url: `data:${source.media_type};base64,${source.data}` } };
  }
  if (source.type === 'url') {
    return { type: 'image_url', image_url: { url: source.url } };
  }
  return null;
}

/** Ajoute une partie à un message `user` OpenAI, en gardant la forme chaîne tant que c'est possible. */
function ajouterPartie(parties, partie) {
  if (partie.type === 'text' && partie.text === '') return;
  parties.push(partie);
}

function contenuUtilisateur(parties) {
  if (parties.every((p) => p.type === 'text')) return parties.map((p) => p.text).join('\n\n');
  return parties;
}

/**
 * Un `tool_result` Anthropic devient un message `role: "tool"`. OpenAI n'y accepte
 * que du texte : les images d'un résultat (un `Read` sur un PNG, par exemple)
 * repartent dans un message `user` placé juste après les messages `tool`.
 */
function resultatOutil(bloc, imagesSuivantes) {
  let texte;
  if (typeof bloc.content === 'string') {
    texte = bloc.content;
  } else if (Array.isArray(bloc.content)) {
    const morceaux = [];
    for (const sous of bloc.content) {
      if (sous && sous.type === 'text') morceaux.push(sous.text);
      else if (sous && sous.type === 'image') {
        const image = imageVersOpenAI(sous);
        if (image) {
          imagesSuivantes.push(image);
          morceaux.push('[image jointe dans le message suivant]');
        }
      }
    }
    texte = morceaux.join('\n\n');
  } else {
    texte = '';
  }
  if (bloc.is_error) texte = `[ERREUR DE L'OUTIL]\n${texte}`;
  return { role: 'tool', tool_call_id: bloc.tool_use_id, content: texte };
}

function messageAssistant(contenu) {
  if (typeof contenu === 'string') return { role: 'assistant', content: contenu };
  const textes = [];
  const appels = [];
  for (const bloc of Array.isArray(contenu) ? contenu : []) {
    if (!bloc) continue;
    if (bloc.type === 'text') textes.push(bloc.text);
    else if (bloc.type === 'tool_use') {
      appels.push({
        id: bloc.id,
        type: 'function',
        function: { name: bloc.name, arguments: JSON.stringify(bloc.input ?? {}) },
      });
    }
    // `thinking` et `redacted_thinking` : pas d'équivalent OpenAI, et leur signature
    // n'a de sens que pour l'API Anthropic. Supprimés.
  }
  const message = { role: 'assistant', content: textes.length ? textes.join('\n\n') : null };
  if (appels.length) message.tool_calls = appels;
  return message;
}

/**
 * Messages Anthropic → messages OpenAI. Trois écarts de forme à combler :
 * - les `tool_result` sont des blocs d'un message `user` chez Anthropic, et des
 *   messages `tool` distincts chez OpenAI, qui doivent suivre l'assistant ;
 * - Claude Code envoie des `role: "system"` en cours de conversation, que les
 *   gabarits de discussion Qwen et Mistral refusent hors de la tête : leur texte est
 *   versé dans le message `user` voisin ;
 * - deux messages `user` consécutifs sont fusionnés, certains gabarits exigeant
 *   l'alternance.
 */
function messagesVersOpenAI(messages) {
  const sortie = [];
  // Texte système en attente d'un message `user` où se poser.
  let systemeEnAttente = [];

  const pousserUtilisateur = (parties) => {
    if (systemeEnAttente.length) {
      parties.unshift({ type: 'text', text: systemeEnAttente.join('\n\n') });
      systemeEnAttente = [];
    }
    const utiles = [];
    for (const p of parties) ajouterPartie(utiles, p);
    if (!utiles.length) return;
    const precedent = sortie[sortie.length - 1];
    if (precedent && precedent.role === 'user') {
      const avant = typeof precedent.content === 'string'
        ? [{ type: 'text', text: precedent.content }]
        : precedent.content;
      precedent.content = contenuUtilisateur([...avant, ...utiles]);
      return;
    }
    sortie.push({ role: 'user', content: contenuUtilisateur(utiles) });
  };

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message) continue;
    if (message.role === 'system') {
      const texte = texteDe(message.content);
      if (texte) systemeEnAttente.push(texte);
      continue;
    }
    if (message.role === 'assistant') {
      // Un texte système resté en attente avant une réponse de l'assistant ne doit
      // pas être perdu : il se pose sur le dernier message `user`.
      if (systemeEnAttente.length) pousserUtilisateur([]);
      sortie.push(messageAssistant(message.content));
      continue;
    }
    // role: user
    if (typeof message.content === 'string') {
      pousserUtilisateur([{ type: 'text', text: message.content }]);
      continue;
    }
    const parties = [];
    const images = [];
    for (const bloc of Array.isArray(message.content) ? message.content : []) {
      if (!bloc) continue;
      if (bloc.type === 'tool_result') {
        sortie.push(resultatOutil(bloc, images));
      } else if (bloc.type === 'text') {
        parties.push({ type: 'text', text: bloc.text });
      } else if (bloc.type === 'image') {
        const image = imageVersOpenAI(bloc);
        if (image) parties.push(image);
      } else if (bloc.type === 'document') {
        parties.push({ type: 'text', text: '[document non transmis : format non pris en charge par le proxy]' });
      }
    }
    pousserUtilisateur([...images, ...parties]);
  }
  if (systemeEnAttente.length) {
    // Rien après : le texte système part en dernier message utilisateur.
    sortie.push({ role: 'user', content: systemeEnAttente.join('\n\n') });
  }
  return sortie;
}

function outilsVersOpenAI(outils) {
  if (!Array.isArray(outils)) return undefined;
  const fonctions = outils
    // Les outils « serveur » d'Anthropic (recherche web, advisor…) n'ont pas
    // d'`input_schema` : ils n'existent pas chez l'amont.
    .filter((outil) => outil && typeof outil.name === 'string' && outil.input_schema)
    .map((outil) => ({
      type: 'function',
      function: {
        name: outil.name,
        description: outil.description || '',
        parameters: outil.input_schema,
      },
    }));
  return fonctions.length ? fonctions : undefined;
}

function choixOutilVersOpenAI(choix) {
  if (!choix || typeof choix !== 'object') return undefined;
  switch (choix.type) {
    case 'auto': return 'auto';
    case 'any': return 'required';
    case 'none': return 'none';
    case 'tool': return { type: 'function', function: { name: choix.name } };
    default: return undefined;
  }
}

/**
 * Corps de requête Anthropic → corps OpenAI.
 * @param {object} corps requête `POST /v1/messages`
 * @param {{ modele: string, plafondMaxTokens?: number }} options
 *   `modele` est imposé : le modèle demandé par le client n'est jamais transmis.
 * @returns {object}
 */
function requeteVersOpenAI(corps, { modele, plafondMaxTokens = PLAFOND_MAX_TOKENS_PAR_DEFAUT } = {}) {
  if (!corps || typeof corps !== 'object') throw new TypeError('corps de requête absent');
  if (typeof modele !== 'string' || !modele) throw new TypeError('modèle amont absent');

  const messages = [];
  const systeme = texteDe(corps.system);
  if (systeme) messages.push({ role: 'system', content: systeme });
  messages.push(...messagesVersOpenAI(corps.messages));

  const sortie = { model: modele, messages };
  const demande = Number.isInteger(corps.max_tokens) && corps.max_tokens > 0
    ? corps.max_tokens
    : plafondMaxTokens;
  sortie.max_tokens = Math.min(demande, plafondMaxTokens);
  if (typeof corps.temperature === 'number') sortie.temperature = corps.temperature;
  if (typeof corps.top_p === 'number') sortie.top_p = corps.top_p;
  if (Array.isArray(corps.stop_sequences) && corps.stop_sequences.length) {
    sortie.stop = corps.stop_sequences;
  }
  const outils = outilsVersOpenAI(corps.tools);
  if (outils) {
    sortie.tools = outils;
    const choix = choixOutilVersOpenAI(corps.tool_choice);
    if (choix) sortie.tool_choice = choix;
    if (corps.tool_choice && corps.tool_choice.disable_parallel_tool_use === true) {
      sortie.parallel_tool_calls = false;
    }
  }
  if (corps.stream === true) {
    sortie.stream = true;
    sortie.stream_options = { include_usage: true };
  }
  return sortie;
}

/**
 * Arguments d'un appel d'outil, chaîne JSON chez OpenAI, objet chez Anthropic. Un
 * JSON invalide devient `{}` : l'outil refusera l'appel pour paramètre manquant, et
 * le modèle recommencera — une exception ici casserait toute la réponse.
 */
function argumentsVersObjet(texte) {
  if (typeof texte !== 'string' || texte.trim() === '') return {};
  try {
    const valeur = JSON.parse(texte);
    return valeur && typeof valeur === 'object' && !Array.isArray(valeur) ? valeur : {};
  } catch {
    return {};
  }
}

function usageVersAnthropic(usage) {
  return {
    input_tokens: (usage && usage.prompt_tokens) || 0,
    output_tokens: (usage && usage.completion_tokens) || 0,
  };
}

/**
 * Réponse OpenAI complète (sans flux) → message Anthropic.
 * @param {object} corps
 * @param {string} modeleDemande renvoyé tel quel au client
 * @returns {object}
 */
function reponseVersAnthropic(corps, modeleDemande) {
  const choix = (corps && Array.isArray(corps.choices) && corps.choices[0]) || {};
  const message = choix.message || {};
  const contenu = [];
  if (typeof message.content === 'string' && message.content !== '') {
    contenu.push({ type: 'text', text: message.content });
  }
  for (const appel of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const fonction = appel.function || {};
    contenu.push({
      type: 'tool_use',
      id: appel.id || identifiant('toolu'),
      name: fonction.name,
      input: argumentsVersObjet(fonction.arguments),
    });
  }
  const aDesOutils = contenu.some((bloc) => bloc.type === 'tool_use');
  return {
    id: identifiant('msg'),
    type: 'message',
    role: 'assistant',
    model: modeleDemande,
    content: contenu,
    // Certains serveurs rendent `stop` alors qu'ils ont produit des appels d'outils :
    // c'est la présence des appels qui décide, sinon Claude Code ne les exécuterait pas.
    stop_reason: aDesOutils ? 'tool_use' : (STOP_REASON[choix.finish_reason] || 'end_turn'),
    stop_sequence: null,
    usage: usageVersAnthropic(corps && corps.usage),
  };
}

/**
 * Traducteur de flux : morceaux SSE OpenAI → événements SSE Anthropic.
 *
 * Le texte est relayé au fil de l'eau. Les appels d'outils, eux, sont **accumulés**
 * et émis d'un bloc à la fin : OpenAI peut entrelacer les morceaux de plusieurs
 * appels (par `index`), alors qu'Anthropic exige des blocs séquentiels, chacun fermé
 * avant le suivant. Claude Code n'exécute de toute façon un outil qu'une fois son bloc
 * complet, et le streaming fin des arguments est coupé par défaut derrière une
 * gateway. Les `ping` du proxy couvrent le silence pendant l'accumulation.
 *
 * @param {string} modeleDemande
 * @returns {{ morceau(chunk: object): object[], fin(): object[], termine: boolean }}
 */
function creerTraducteurFlux(modeleDemande) {
  let demarre = false;
  let indexBloc = -1;
  let texteOuvert = false;
  let finishReason = null;
  let usage = null;
  let fini = false;
  const appels = new Map(); // index OpenAI -> { id, nom, arguments }

  const debut = () => {
    if (demarre) return [];
    demarre = true;
    return [{
      type: 'message_start',
      message: {
        id: identifiant('msg'),
        type: 'message',
        role: 'assistant',
        model: modeleDemande,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }];
  };

  const fermerTexte = () => {
    if (!texteOuvert) return [];
    texteOuvert = false;
    return [{ type: 'content_block_stop', index: indexBloc }];
  };

  return {
    get termine() { return fini; },

    morceau(chunk) {
      if (fini || !chunk || typeof chunk !== 'object') return [];
      const evenements = debut();
      if (chunk.usage) usage = chunk.usage;
      const choix = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
      if (!choix) return evenements;
      const delta = choix.delta || {};

      if (typeof delta.content === 'string' && delta.content !== '') {
        if (!texteOuvert) {
          indexBloc += 1;
          texteOuvert = true;
          evenements.push({ type: 'content_block_start', index: indexBloc, content_block: { type: 'text', text: '' } });
        }
        evenements.push({ type: 'content_block_delta', index: indexBloc, delta: { type: 'text_delta', text: delta.content } });
      }
      // `delta.reasoning_content` (raisonnement de Qwen) : ignoré. Un bloc `thinking`
      // Anthropic exige une signature que seul l'API Anthropic sait produire.

      for (const morceauAppel of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const index = Number.isInteger(morceauAppel.index) ? morceauAppel.index : appels.size;
        const appel = appels.get(index) || { id: null, nom: '', arguments: '' };
        if (morceauAppel.id) appel.id = morceauAppel.id;
        const fonction = morceauAppel.function || {};
        if (fonction.name) appel.nom += fonction.name;
        if (typeof fonction.arguments === 'string') appel.arguments += fonction.arguments;
        appels.set(index, appel);
      }

      if (choix.finish_reason) finishReason = choix.finish_reason;
      return evenements;
    },

    fin() {
      if (fini) return [];
      fini = true;
      const evenements = debut();
      evenements.push(...fermerTexte());
      const tries = [...appels.entries()].sort(([a], [b]) => a - b);
      for (const [, appel] of tries) {
        indexBloc += 1;
        evenements.push({
          type: 'content_block_start',
          index: indexBloc,
          content_block: { type: 'tool_use', id: appel.id || identifiant('toolu'), name: appel.nom, input: {} },
        });
        evenements.push({
          type: 'content_block_delta',
          index: indexBloc,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(argumentsVersObjet(appel.arguments)) },
        });
        evenements.push({ type: 'content_block_stop', index: indexBloc });
      }
      const stopReason = appels.size ? 'tool_use' : (STOP_REASON[finishReason] || 'end_turn');
      evenements.push({
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: usageVersAnthropic(usage),
      });
      evenements.push({ type: 'message_stop' });
      return evenements;
    },
  };
}

/**
 * Erreur amont → enveloppe d'erreur Anthropic. Le message amont est recopié sans
 * réécriture : la reprise automatique de Claude Code reconnaît certains refus à leur
 * libellé (`Extra inputs are not permitted`, `Unexpected role "system"`…).
 * @param {number} statut statut HTTP amont
 * @param {string} texte corps brut de la réponse amont
 * @returns {{ type: 'error', error: { type: string, message: string } }}
 */
function erreurVersAnthropic(statut, texte) {
  let message = typeof texte === 'string' ? texte : '';
  try {
    const corps = JSON.parse(message);
    const candidat = corps && (
      (corps.error && (corps.error.message || (typeof corps.error === 'string' && corps.error)))
      || corps.message
      || corps.detail
    );
    if (typeof candidat === 'string' && candidat) message = candidat;
  } catch {
    // Corps non JSON : recopié tel quel.
  }
  const type = TYPE_ERREUR_PAR_STATUT[statut] || (statut >= 500 ? 'api_error' : 'invalid_request_error');
  return { type: 'error', error: { type, message: message || `erreur amont HTTP ${statut}` } };
}

module.exports = {
  requeteVersOpenAI,
  reponseVersAnthropic,
  creerTraducteurFlux,
  erreurVersAnthropic,
};
