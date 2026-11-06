'use strict';

// Proxy local Anthropic Messages → OpenAI Chat Completions, pour brancher Claude Code
// sur un modèle Scaleway Generative APIs.
//
// Claude Code s'y connecte par `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` et
// `ANTHROPIC_API_KEY=<PROXY_JETON>`. Variables lues : voir `plan/contrat.md`,
// section « `proxy.js` ». La traduction elle-même est dans `lib/traduction.js`.
//
// Bibliothèque standard uniquement, CommonJS. `fetch` est celui de Node.
//
// Sortie standard : la PREMIÈRE ligne est `PORT=<n>`, pour qu'un appelant qui a
// demandé `PROXY_PORT=0` sache où se connecter. Le journal part ensuite sur la sortie
// d'erreur, une ligne JSON par requête, sans jamais de corps de requête.

const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');

const {
  requeteVersOpenAI,
  reponseVersAnthropic,
  creerTraducteurFlux,
  erreurVersAnthropic,
} = require('./lib/traduction');
const { masquerSecrets } = require('./lib/texte');

const BASE_URL_PAR_DEFAUT = 'https://api.scaleway.ai/v1';
const PORT_PAR_DEFAUT = 4000;
const PLAFOND_MAX_TOKENS_PAR_DEFAUT = 16384;
const INTERVALLE_PING_PAR_DEFAUT = 10000;
// Une requête Claude Code porte tout l'historique, images comprises.
const TAILLE_MAX_CORPS = 64 * 1024 * 1024;
// Au-delà, l'amont est considéré comme perdu. Claude Code relance de lui-même.
const DELAI_AMONT_MS = 10 * 60 * 1000;

function echouer(message) {
  process.stderr.write(`proxy : ${message}\n`);
  process.exit(2);
}

function entierPositif(nom, valeur, defaut, { zeroPermis = false } = {}) {
  if (valeur === undefined || valeur === '') return defaut;
  const n = Number(valeur);
  if (!Number.isInteger(n) || n < 0 || (n === 0 && !zeroPermis)) {
    echouer(`${nom} doit être un entier ${zeroPermis ? 'positif ou nul' : 'strictement positif'}, reçu ${JSON.stringify(valeur)}`);
  }
  return n;
}

function lireConfiguration(env) {
  const modele = env.SCW_MODELE;
  if (!modele) echouer('SCW_MODELE est obligatoire');
  const jeton = env.PROXY_JETON;
  if (!jeton) echouer('PROXY_JETON est obligatoire');
  const cheminCle = env.SCW_CLE_FICHIER;
  if (!cheminCle) echouer('SCW_CLE_FICHIER est obligatoire (chemin du fichier de clé, pas la clé)');
  let cle;
  try {
    cle = fs.readFileSync(cheminCle, 'utf8').trim();
  } catch (erreur) {
    echouer(`lecture de SCW_CLE_FICHIER impossible : ${erreur.code || erreur.message}`);
  }
  if (!cle) echouer('le fichier SCW_CLE_FICHIER est vide');
  return {
    modele,
    jeton,
    cle,
    baseUrl: (env.SCW_BASE_URL || BASE_URL_PAR_DEFAUT).replace(/\/+$/, ''),
    port: entierPositif('PROXY_PORT', env.PROXY_PORT, PORT_PAR_DEFAUT, { zeroPermis: true }),
    plafondMaxTokens: entierPositif('PLAFOND_MAX_TOKENS', env.PLAFOND_MAX_TOKENS, PLAFOND_MAX_TOKENS_PAR_DEFAUT),
    intervallePing: entierPositif('INTERVALLE_PING_MS', env.INTERVALLE_PING_MS, INTERVALLE_PING_PAR_DEFAUT),
  };
}

/** Comparaison en temps constant, longueurs comprises. */
function jetonValide(recu, attendu) {
  if (typeof recu !== 'string' || !recu) return false;
  const a = crypto.createHash('sha256').update(recu).digest();
  const b = crypto.createHash('sha256').update(attendu).digest();
  return crypto.timingSafeEqual(a, b);
}

function jetonDeLaRequete(req) {
  const cle = req.headers['x-api-key'];
  if (typeof cle === 'string' && cle) return cle;
  const autorisation = req.headers.authorization;
  if (typeof autorisation === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(autorisation);
    if (m) return m[1].trim();
  }
  return '';
}

function lireCorps(req) {
  return new Promise((resoudre, rejeter) => {
    const morceaux = [];
    let taille = 0;
    req.on('data', (morceau) => {
      taille += morceau.length;
      if (taille > TAILLE_MAX_CORPS) {
        rejeter(Object.assign(new Error('corps de requête trop volumineux'), { statut: 413 }));
        req.destroy();
        return;
      }
      morceaux.push(morceau);
    });
    req.on('end', () => resoudre(Buffer.concat(morceaux).toString('utf8')));
    req.on('error', rejeter);
  });
}

/**
 * `retry-after` en secondes entières : Claude Code ne lit pas la forme date HTTP.
 * @returns {string|null}
 */
function retryAfterEnSecondes(valeur) {
  if (!valeur) return null;
  if (/^\d+$/.test(valeur.trim())) return valeur.trim();
  const date = Date.parse(valeur);
  if (Number.isNaN(date)) return null;
  return String(Math.max(0, Math.ceil((date - Date.now()) / 1000)));
}

function sse(evenement) {
  return `event: ${evenement.type}\ndata: ${JSON.stringify(evenement)}\n\n`;
}

function creerServeur(config, journal) {
  const masquer = (s) => masquerSecrets(String(s).split(config.cle).join('[SECRET RETIRÉ]'));

  const repondreErreur = (res, statut, type, message, entetes = {}) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(statut, { 'content-type': 'application/json', ...entetes });
    res.end(JSON.stringify({ type: 'error', error: { type, message } }));
  };

  async function traiterMessages(req, res, trace) {
    let corps;
    try {
      corps = JSON.parse(await lireCorps(req));
    } catch (erreur) {
      if (erreur.statut === 413) return repondreErreur(res, 413, 'request_too_large', erreur.message);
      return repondreErreur(res, 400, 'invalid_request_error', 'corps de requête JSON invalide');
    }
    trace.modeleDemande = typeof corps.model === 'string' ? corps.model : null;
    trace.flux = corps.stream === true;

    let requete;
    try {
      requete = requeteVersOpenAI(corps, { modele: config.modele, plafondMaxTokens: config.plafondMaxTokens });
    } catch (erreur) {
      return repondreErreur(res, 400, 'invalid_request_error', erreur.message);
    }

    // Le client qui raccroche (Ctrl-C, relance) coupe aussi l'appel amont : sans quoi
    // le modèle continuerait de générer — et de facturer — pour personne.
    const abandon = new AbortController();
    const minuterie = setTimeout(() => abandon.abort(new Error('délai amont dépassé')), DELAI_AMONT_MS);
    res.on('close', () => {
      if (!res.writableFinished) abandon.abort(new Error('client parti'));
    });

    let reponse;
    try {
      reponse = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.cle}`,
          'content-type': 'application/json',
          accept: trace.flux ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(requete),
        signal: abandon.signal,
      });
    } catch (erreur) {
      clearTimeout(minuterie);
      trace.erreur = masquer(erreur.cause ? erreur.cause.message || erreur.cause : erreur.message);
      return repondreErreur(res, 502, 'api_error', `amont injoignable : ${trace.erreur}`);
    }
    trace.statutAmont = reponse.status;

    if (!reponse.ok) {
      clearTimeout(minuterie);
      const texte = await reponse.text().catch(() => '');
      const enveloppe = erreurVersAnthropic(reponse.status, masquer(texte));
      const entetes = {};
      const retry = retryAfterEnSecondes(reponse.headers.get('retry-after'));
      if (retry !== null) entetes['retry-after'] = retry;
      const doitReessayer = reponse.headers.get('x-should-retry');
      if (doitReessayer) entetes['x-should-retry'] = doitReessayer;
      trace.erreur = enveloppe.error.message.slice(0, 300);
      return repondreErreur(res, reponse.status, enveloppe.error.type, enveloppe.error.message, entetes);
    }

    if (!trace.flux) {
      try {
        const sortie = reponseVersAnthropic(await reponse.json(), trace.modeleDemande);
        trace.usage = sortie.usage;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(sortie));
      } catch (erreur) {
        trace.erreur = masquer(erreur.message);
        repondreErreur(res, 502, 'api_error', `réponse amont illisible : ${trace.erreur}`);
      } finally {
        clearTimeout(minuterie);
      }
      return undefined;
    }

    // Flux : pas de mise en tampon — Claude Code lit événement par événement et
    // décroche si rien n'arrive pendant son délai d'inactivité.
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.flushHeaders();
    const traducteur = creerTraducteurFlux(trace.modeleDemande);
    const ecrire = (evenements) => {
      for (const e of evenements) {
        if (e.type === 'message_delta') trace.usage = e.usage;
        res.write(sse(e));
      }
    };
    const ping = setInterval(() => res.write(sse({ type: 'ping' })), config.intervallePing);

    let tampon = '';
    let finAmont = false;
    const decodeur = new TextDecoder();
    const traiterLigne = (ligne) => {
      if (!ligne.startsWith('data:')) return;
      const donnees = ligne.slice(5).trim();
      if (donnees === '[DONE]') {
        finAmont = true;
        return;
      }
      let morceau;
      try {
        morceau = JSON.parse(donnees);
      } catch {
        return;
      }
      if (morceau && morceau.error) {
        throw Object.assign(new Error('erreur amont dans le flux'), { morceau });
      }
      ecrire(traducteur.morceau(morceau));
    };

    try {
      for await (const octets of reponse.body) {
        tampon += decodeur.decode(octets, { stream: true });
        let fin;
        while ((fin = tampon.indexOf('\n')) !== -1) {
          traiterLigne(tampon.slice(0, fin).replace(/\r$/, ''));
          tampon = tampon.slice(fin + 1);
        }
      }
      tampon += decodeur.decode();
      if (tampon) traiterLigne(tampon.replace(/\r$/, ''));
      if (!finAmont) {
        // Flux coupé sans `[DONE]` : on le signale au lieu de fabriquer une fin
        // propre. Un `message_stop` inventé ferait passer une réponse tronquée pour
        // complète ; une erreur fait relancer Claude Code.
        throw new Error('flux amont interrompu avant [DONE]');
      }
      ecrire(traducteur.fin());
    } catch (erreur) {
      if (erreur.morceau) {
        const e = erreur.morceau.error;
        const message = typeof e === 'string' ? e : (e && e.message) || 'erreur amont';
        trace.erreur = masquer(message).slice(0, 300);
        res.write(sse({ type: 'error', error: { type: 'api_error', message: masquer(message) } }));
      } else if (!abandon.signal.aborted || abandon.signal.reason?.message !== 'client parti') {
        trace.erreur = masquer(erreur.message);
        res.write(sse({ type: 'error', error: { type: 'api_error', message: trace.erreur } }));
      }
    } finally {
      clearInterval(ping);
      clearTimeout(minuterie);
      res.end();
    }
    return undefined;
  }

  return http.createServer((req, res) => {
    const debut = Date.now();
    const chemin = new URL(req.url, 'http://proxy').pathname;
    const trace = { methode: req.method, chemin };
    // `close` et non `finish` : un client qui raccroche en plein flux doit laisser
    // une ligne au journal, et `finish` ne serait jamais émis.
    res.on('close', () => {
      journal(masquer(JSON.stringify({
        date: new Date().toISOString(),
        ...trace,
        modeleAmont: trace.modeleDemande !== undefined ? config.modele : undefined,
        statut: res.statusCode,
        dureeMs: Date.now() - debut,
      })));
    });

    // Sonde de démarrage de Claude Code : sans authentification, sans effet.
    if (req.method === 'HEAD' && chemin === '/api/hello') {
      res.writeHead(200);
      res.end();
      return;
    }
    if (!jetonValide(jetonDeLaRequete(req), config.jeton)) {
      repondreErreur(res, 401, 'authentication_error', 'jeton du proxy absent ou invalide');
      return;
    }
    if (req.method === 'POST' && chemin === '/v1/messages') {
      traiterMessages(req, res, trace).catch((erreur) => {
        trace.erreur = masquer(erreur.message);
        repondreErreur(res, 500, 'api_error', 'erreur interne du proxy');
      });
      return;
    }
    // `count_tokens` et `/v1/models` sont optionnels : leur absence fait estimer
    // le contexte par caractères à Claude Code, sans erreur.
    repondreErreur(res, 404, 'not_found_error', `route inconnue du proxy : ${req.method} ${chemin}`);
  });
}

function principal() {
  const config = lireConfiguration(process.env);
  const journal = (ligne) => process.stderr.write(`${ligne}\n`);
  const serveur = creerServeur(config, journal);
  serveur.listen(config.port, '127.0.0.1', () => {
    process.stdout.write(`PORT=${serveur.address().port}\n`);
  });
  const arreter = () => serveur.close(() => process.exit(0));
  process.on('SIGTERM', arreter);
  process.on('SIGINT', arreter);
}

principal();
