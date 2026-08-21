#!/usr/bin/env node
'use strict';

// scripts/rendre-compte.js — filet de sécurité du step `if: always()` (lot 4, R12).
//
// Une composite action n'a pas de `post:` : le schéma `composite-runs` ne connaît que
// `{using, steps}`. Quand `resolve.js` meurt avant `publierCompteRendu` — plantage,
// `timeout-minutes` du consommateur, job annulé — l'utilisateur ne voit que la
// réaction 👀 posée sur son issue : aucun commentaire, aucun signal. C'est le
// scénario « il attend et ne comprend pas ». Ce script publie alors le compte rendu
// manquant.
//
// LE CRITÈRE DE SILENCE EST LE MARQUEUR, ET RIEN D'AUTRE : ce script publie sauf s'il
// trouve un compte rendu portant le marqueur de CE run — figé dans `plan/contrat.md`,
// invisible dans le rendu GitHub, et écrit par nous, pas par un tiers. Il le cherche
// des DEUX côtés, la cible puis l'autre candidat, parce que la cible n'est pas toujours
// celle qu'a choisie `resolve.js` : voir `compteRenduDejaPublie`. Son propre compte
// rendu porte le même marqueur : deux exécutions du step (reprise de job, relance
// manuelle) ne doivent pas laisser deux commentaires.
//
// `${{ job.status }}` n'est PLUS consommée : mesuré sur le run 32380365244, un step de
// composite qui suit un step de la même composite terminé en `conclusion=failure`
// reçoit `success` — le court-circuit qu'on en tirait faisait taire ce script dans le
// seul scénario pour lequel il existe. Le fait qu'on lit désormais est un fait que
// l'action écrit elle-même. Procès-verbal complet dans `plan/contrat.md`, section
// « Ce que vaut `${{ job.status }}` dans une composite action ».
//
// Conséquence R7, favorable : la seule valeur d'environnement qui atteigne encore le
// corps publié est `config.branche`, validée par `/^fix-issue-\d+$/`. Le corps est
// donc intégralement statique — plus rien à citer, à masquer ni à borner dedans.
//
// Code de sortie : 0 sur TOUS les chemins, échec de publication compris. Ce script
// est le dernier step du job, sous `if: always()` : rougir ici ferait passer au rouge
// un job dont la validation est passée, et masquerait le verdict déjà rendu par le
// code de sortie de `resolve.js`. Un échec s'annonce donc par `::error::`, comme dans
// la garde.
//
// Bibliothèque standard de Node uniquement, CommonJS : aucune dépendance, aucun
// `package.json`. Les noms lus dans l'environnement sont ceux de `plan/contrat.md`,
// seule source de vérité.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { gh } = require('./lib/gh.js');
const { masquerSecrets } = require('./lib/texte.js');

// ---------------------------------------------------------------------------
// Journal du job
//
// Ces quatre fonctions sont une copie compacte de celles de `resolve.js`, qui ne les
// exporte pas : les importer voudrait dire charger tout l'orchestrateur pour quatre
// lignes, dans le seul script du job qui doive tourner quand `resolve.js` vient de
// mourir. Mêmes règles qu'là-bas : masquage systématique (R7), et encodage des
// retours à la ligne en `%0A` parce qu'une commande de workflow est mono-ligne.
// ---------------------------------------------------------------------------

function journaliser(message) {
  process.stdout.write(`${masquerSecrets(String(message))}\n`);
}

function surUneLigne(message) {
  return String(message).replace(/\r?\n/g, '%0A');
}

function avertir(message) {
  journaliser(`::warning::${surUneLigne(masquerSecrets(String(message)))}`);
}

function erreur(message) {
  journaliser(`::error::${surUneLigne(masquerSecrets(String(message)))}`);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MOTIF_BRANCHE = /^fix-issue-\d+$/;
// `owner/repo`, sans slash supplémentaire : cette valeur part en argument de
// `--repo`, et une forme non contrôlée y désignerait un autre dépôt.
const MOTIF_DEPOT = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function lireEnv(nom) {
  const valeur = process.env[nom];
  return typeof valeur === 'string' ? valeur.trim() : '';
}

/**
 * Lit et valide l'environnement. Lève sur une entrée invalide : `principal()`
 * transforme l'exception en `::error::` et en code de sortie 0.
 *
 * Fail-closed : on ne poste pas sur une cible qu'on n'a pas su valider. Un numéro
 * ou une branche mal formés ne viennent pas d'un utilisateur mais d'un câblage
 * `env:` incomplet dans `action.yml` — et une composite action n'expose PAS ses
 * inputs en `INPUT_*`, donc c'est l'oubli le plus probable de tout le plan.
 *
 * @returns {Readonly<object>}
 */
function lireConfiguration() {
  const depot = lireEnv('GITHUB_REPOSITORY');
  const numeroBrut = lireEnv('NUMERO_ISSUE');
  const branche = lireEnv('BRANCHE');

  if (!MOTIF_DEPOT.test(depot)) {
    throw new Error(
      `GITHUB_REPOSITORY invalide : ${JSON.stringify(depot)}. Attendu « proprietaire/depot ». ` +
        'Aucun compte rendu de secours publié : la cible ne peut pas être désignée.',
    );
  }

  // `/^\d+$/` AVANT `Number` : `Number('0x10')` vaut 16 et `Number('1e3')` vaut 1000,
  // et tous deux passent `Number.isInteger`. Mesuré : `NUMERO_ISSUE=0x10` était accepté
  // et le compte rendu visait l'issue #16. Le contrat dit « validée `Number.isInteger` »,
  // mais le message d'erreur ci-dessous promet un entier DÉCIMAL : c'est ce qu'on
  // contrôle, sinon la promesse est fausse.
  const numeroIssue = /^\d+$/.test(numeroBrut) ? Number(numeroBrut) : NaN;
  // `isSafeInteger` et non `isInteger` : au-delà de 2^53, la chaîne validée n'est plus
  // celle qui part en argv. Mesuré : `NUMERO_ISSUE=99999999999999999999` passait, puis
  // `gh issue comment 100000000000000000000` visait une issue qui n'existe pas.
  if (!Number.isSafeInteger(numeroIssue) || numeroIssue <= 0) {
    throw new Error(
      `NUMERO_ISSUE invalide : ${JSON.stringify(numeroBrut)}. Attendu la sortie « issue » ` +
        "de scripts/garde.js, un entier décimal positif. Vérifier la ligne " +
        'NUMERO_ISSUE du bloc env: du step. Aucun compte rendu de secours publié.',
    );
  }

  // Même règle que `resolve.js` : `BRANCHE` vient de la sortie `branche` de la garde
  // et fait foi, mais sa forme est revalidée parce qu'elle part en argument de `gh`.
  if (!MOTIF_BRANCHE.test(branche)) {
    throw new Error(
      `BRANCHE invalide : ${JSON.stringify(branche)}. Attendu la sortie « branche » de ` +
        'scripts/garde.js, de la forme fix-issue-<n>. Vérifier la ligne BRANCHE du bloc ' +
        'env: du step. Aucun compte rendu de secours publié.',
    );
  }

  return Object.freeze({
    depot,
    numeroIssue,
    branche,
    jetonGh: lireEnv('GH_TOKEN'),
    // Tous les inputs d'action sont des chaînes : on ne compare qu'à `'true'`,
    // jamais à `'false'`.
    sansPublication: lireEnv('SANS_PUBLICATION') === 'true',
    // Calculée UNE fois : le corps publié et la reconnaissance du « déjà publié »
    // doivent parler de la même portée, sinon ce script ne reconnaît pas son propre
    // marqueur à l'exécution suivante.
    porteeRun: porteeDuRun(),
  });
}

// ---------------------------------------------------------------------------
// Corps du compte rendu de secours
// ---------------------------------------------------------------------------

// Seule source de vérité de la forme du marqueur DANS CE FICHIER. Elle doit rester
// égale à celle de `publierCompteRendu` (`scripts/resolve.js`) : c'est tout le
// mécanisme d'idempotence, et deux formes divergentes font poster un doublon à chaque
// job rouge. Figée dans `plan/contrat.md`.
const NOM_MARQUEUR_COMPTE_RENDU = 'deepseek-resolve:compte-rendu';

// Forme NUE, sans portée de run : celle d'un run local ou de test, et celle des
// comptes rendus écrits avant que la portée existe. Exportée pour que
// `test/compte-rendu.test.js` puisse la comparer au contrat.
const MARQUEUR_COMPTE_RENDU = `<!-- ${NOM_MARQUEUR_COMPTE_RENDU} -->`;

/**
 * Portée du run courant, `''` hors GitHub Actions.
 *
 * Même règle et même forme que `porteeDuRun()` de `scripts/resolve.js` — les deux
 * doivent rester égales.
 *
 * R9 fait servir le même couple issue / branche à PLUSIEURS runs : un second
 * « @dseek » reprend `fix-issue-<n>` et la même PR, où le compte rendu du run
 * précédent est encore. Sans portée, ce script s'y reconnaît, se croit déjà passé et
 * publie... rien — sur la panne même que le step `if: always()` existe pour couvrir.
 * Mesuré, et tranché dans `plan/contrat.md`.
 *
 * `GITHUB_RUN_ATTEMPT` est dans la portée à dessein : une relance de job est un
 * nouveau verdict, donc un compte rendu de plus, pas un doublon. Deux exécutions du
 * step dans la MÊME tentative gardent la même portée, et restent idempotentes.
 *
 * Ces deux variables sont fournies d'office par le runner à tous les steps : aucune
 * ligne d'`env:` à ajouter dans `action.yml`, donc aucune ligne de plus à oublier.
 *
 * `^\d+$` sur les deux valeurs : elles partent dans un commentaire HTML, et une
 * valeur portant « --> » le refermerait en avance. Toute valeur inattendue est
 * traitée comme une absence.
 *
 * @returns {string} « <id>-<tentative> », ou `''` si la portée est inconnue
 */
function porteeDuRun() {
  const identifiant = lireEnv('GITHUB_RUN_ID');
  const tentative = lireEnv('GITHUB_RUN_ATTEMPT');
  if (!/^\d+$/.test(identifiant) || !/^\d+$/.test(tentative)) return '';
  return `${identifiant}-${tentative}`;
}

/**
 * Marqueur à écrire en fin de compte rendu.
 *
 * La portée est passée en ARGUMENT ici, alors que `resolve.js` la lit dans
 * l'environnement : c'est ce qui permet à `test/compte-rendu.test.js` d'exercer la
 * forme sans réécrire `process.env`. `lireConfiguration` la calcule une fois.
 *
 * @param {string} portee valeur rendue par `porteeDuRun()`
 * @returns {string}
 */
function marqueurCompteRendu(portee) {
  if (typeof portee !== 'string' || portee === '') return MARQUEUR_COMPTE_RENDU;
  return `<!-- ${NOM_MARQUEUR_COMPTE_RENDU} run=${portee} -->`;
}

/**
 * Motif reconnaissant les DEUX formes, la portée étant capturée si elle est là.
 *
 * Une comparaison de chaîne exacte ne suffirait pas : un commentaire laissé par un
 * ancien run porte le marqueur nu, et il faut savoir le lire pour décider.
 *
 * Une expression NEUVE à chaque appel, jamais une constante globale : un motif `g`
 * partagé garde son `lastIndex` d'un appel à l'autre et se met à sauter des
 * occurrences.
 */
function motifMarqueur() {
  return new RegExp(
    `<!--\\s*${NOM_MARQUEUR_COMPTE_RENDU}(?:\\s+run=(\\d+-\\d+))?\\s*-->`,
    'g',
  );
}

/**
 * Construit le corps du compte rendu de secours.
 *
 * Aucun texte tiers n'y entre : ni titre, ni corps d'issue, ni sortie de
 * sous-processus. Et plus aucune valeur d'environnement non plus, hormis
 * `config.branche`, validée par `/^fix-issue-\d+$/` : le corps est statique.
 *
 * `⚠️` et non `❌` : `❌` est le vocabulaire de la boucle, qui rend un verdict
 * (« ❌ Échec après … », `scripts/resolve.js`). Ce script-ci n'en rend aucun — il ne
 * connaît pas la cause de l'arrêt, il sait seulement qu'aucun compte rendu n'existe
 * pour ce run. D'où l'ÉNUMÉRATION des causes possibles au paragraphe suivant, et
 * aucune affirmation : rapporter « le job a échoué » à qui vient de voir son job
 * annulé, ou son délai dépassé, l'envoie chercher une panne là où il n'y en a pas.
 *
 * @param {Readonly<object>} config
 * @param {{ verificationImpossible?: boolean }} [options]
 *   `verificationImpossible` : `compteRenduDejaPublie` a rendu `null`, donc la
 *   présence d'un compte rendu n'a pas pu être contrôlée. L'arbitrage « plutôt un
 *   doublon qu'un silence » publie quand même — le corps doit alors le DIRE, sinon il
 *   affirme au lecteur qu'aucun compte rendu n'existe alors que personne n'a pu le
 *   vérifier.
 * @returns {string} corps markdown, terminé par le marqueur
 */
function construireCorpsSecours(config, { verificationImpossible = false } = {}) {
  const lignes = ["⚠️ L'action s'est arrêtée sans publier de compte rendu pour ce run."];

  lignes.push('');
  lignes.push(
    "Ce message est publié par le filet de sécurité de l'action, pas par sa boucle de " +
      "résolution : celle-ci ne s'est pas rendue jusqu'à son propre compte rendu, et " +
      "l'état exact du travail n'est donc pas connu ici. Les causes possibles sont un " +
      "arrêt brutal de l'action, une annulation du job, un délai d'exécution dépassé du " +
      'workflow appelant, ou une publication refusée — ce message ne permet pas de ' +
      'trancher entre elles.',
  );

  if (verificationImpossible) {
    lignes.push('');
    lignes.push(
      "L'action n'a pas pu relire les commentaires existants : si un compte rendu a déjà " +
        'été publié pour ce run, ce message en est un doublon.',
    );
  }

  lignes.push('');
  // Les logs du job sont la seule chose qu'on ait réellement à offrir : la sortie
  // d'aider et celle de la commande de validation n'y sont pas recopiées, parce
  // qu'elles peuvent contenir des secrets du job (R7).
  lignes.push(
    'Ce qui reste consultable : les **logs du job**, seul endroit où figurent la sortie ' +
      "d'aider et celle de la commande de validation. Elles ne sont pas recopiées ici : " +
      'elles peuvent contenir des secrets du job.',
  );

  lignes.push('');
  lignes.push(
    `La branche \`${config.branche}\` porte le travail déjà poussé, s'il y en a eu. ` +
      "Relancer l'action sur cette issue reprend cette branche là où elle en est, sans " +
      'repartir de zéro.',
  );

  lignes.push('');
  lignes.push(marqueurCompteRendu(config.porteeRun));

  return lignes.join('\n');
}

/**
 * Un compte rendu de CE run est-il dans ce texte ?
 *
 * Deux régimes, tranchés dans `plan/contrat.md` :
 *
 * - portée connue : seul le marqueur de cette portée compte. Le compte rendu d'un run
 *   précédent — porté par une autre portée, ou nu — ne fait pas taire ce script ;
 * - portée inconnue (`''`, donc hors Actions) : repli, n'importe quel compte rendu
 *   compte. Rien ne permettrait de distinguer les runs, et c'est le seul régime des
 *   exécutions locales et du harnais.
 *
 * @param {unknown} texte
 * @param {string} [portee] portée du run courant ; `''` = repli
 * @returns {boolean}
 */
function contientMarqueur(texte, portee = '') {
  if (typeof texte !== 'string') return false;
  const motif = motifMarqueur();
  let trouve;
  while ((trouve = motif.exec(texte)) !== null) {
    if (typeof portee !== 'string' || portee === '') return true;
    if (trouve[1] === portee) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Lectures via `gh`
//
// Toutes en `tolererEchec: true` : « pas de PR pour cette branche » est une
// réponse, pas une panne. Toutes portent `--repo <GITHUB_REPOSITORY>` — sans lui,
// `gh` résout le dépôt par le remote du répertoire courant, ce qui marche par effet
// de bord en production et interroge le mauvais dépôt en test.
// ---------------------------------------------------------------------------

/**
 * Numéro de la pull request de `BRANCHE`, ou `null` si elle n'existe pas — ou si on
 * n'a pas pu le savoir.
 *
 * `--state all` et non `--state open` : une PR fermée entre-temps porte quand même
 * le compte rendu de `resolve.js`. Sur plusieurs PR pour la même branche, la plus
 * récente est celle du run courant, donc le plus grand numéro.
 *
 * Ce que `--state all` décide ici, c'est la CIBLE, et rien d'autre : la recherche du
 * marqueur, elle, interroge les deux candidats (`compteRenduDejaPublie`), donc une PR
 * fermée qui porte le compte rendu ne peut plus faire republier côté issue. Que la
 * cible reste une PR fermée — donc un compte rendu de secours sur une PR que personne
 * ne relit — est une dette assumée, consignée dans `plan/contrat.md` et suivie par
 * l'issue #6 : la corriger rouvre le choix de la cible, pas cette fonction.
 *
 * Une lecture impossible est traitée comme « pas de PR » : le compte rendu part
 * alors sur l'issue, qui existe toujours. Le pire cas est un doublon de
 * commentaire, jamais un silence — c'est l'arbitrage de tout ce script.
 *
 * @param {Readonly<object>} config
 * @returns {number|null}
 */
function numeroPrDeLaBranche(config) {
  let reponse;
  try {
    reponse = gh(
      [
        'pr',
        'list',
        '--repo',
        config.depot,
        '--head',
        config.branche,
        '--state',
        'all',
        '--json',
        'number',
      ],
      { json: true, tolererEchec: true },
    );
  } catch (err) {
    avertir(
      `Impossible de retrouver la pull request de ${config.branche} : ` +
        `${err && err.message ? err.message : err}. Le compte rendu de secours partira sur ` +
        `l'issue #${config.numeroIssue}.`,
    );
    return null;
  }
  // `null` et « tableau vide » ne disent PAS la même chose, et les confondre coûte un
  // silence : `lib/gh.js` rend `null` sur un code de sortie non nul quand
  // `tolererEchec` est posé — jeton sans droit de lecture sur les pull requests, panne
  // d'API — alors que `[]` veut dire « cette branche n'a pas de PR ». Sans cette
  // distinction, le compte rendu part sur l'issue sans une ligne pour dire pourquoi,
  // et le lecteur cherche une PR qui existe pourtant. Le repli reste le bon arbitrage,
  // c'est son silence qui était le défaut.
  if (reponse === null) {
    avertir(
      `« gh pr list » n'a pas répondu pour ${config.branche} : impossible de savoir si une ` +
        `pull request existe. Le compte rendu de secours partira sur l'issue ` +
        `#${config.numeroIssue}.`,
    );
    return null;
  }
  // Même raisonnement un cran plus loin : une réponse qui n'est pas la liste attendue
  // — objet au lieu de tableau, `number` en chaîne — n'est PAS « cette branche n'a pas
  // de PR ». Sans ce cas, le repli sur l'issue était de nouveau muet, alors que le
  // commentaire ci-dessus prétend avoir refermé ce silence. Relevé par la relecture.
  const numeros = Array.isArray(reponse)
    ? reponse
        .map((entree) => (entree && Number.isInteger(entree.number) ? entree.number : null))
        .filter((numero) => numero !== null)
    : [];
  if (!Array.isArray(reponse) || (reponse.length > 0 && numeros.length === 0)) {
    avertir(
      `« gh pr list » a répondu une forme inattendue pour ${config.branche} : impossible ` +
        `d'en tirer un numéro de pull request. Le compte rendu de secours partira sur ` +
        `l'issue #${config.numeroIssue}.`,
    );
    return null;
  }
  // Tableau vide : réponse claire, « cette branche n'a pas de PR ». Rien à signaler.
  if (numeros.length === 0) return null;
  return Math.max(...numeros);
}

/**
 * Cible de PUBLICATION : la pull request si elle existe, l'issue sinon. C'est le choix
 * de `publierCompteRendu`, qui poste sur l'une ou sur l'autre selon `bilan.numeroPr`.
 *
 * Sert aussi à désigner le second candidat de `compteRenduDejaPublie` : appelée avec
 * `null`, elle rend l'issue. La RECHERCHE du marqueur, elle, ne se contente pas de la
 * cible — voir `compteRenduDejaPublie`.
 *
 * @param {Readonly<object>} config
 * @param {number|null} numeroPr
 * @returns {Readonly<{ type: 'pr'|'issue', numero: number, libelle: string }>}
 */
function choisirCible(config, numeroPr) {
  if (numeroPr === null) {
    return Object.freeze({
      type: 'issue',
      numero: config.numeroIssue,
      libelle: `l'issue #${config.numeroIssue}`,
    });
  }
  return Object.freeze({
    type: 'pr',
    numero: numeroPr,
    libelle: `la pull request #${numeroPr}`,
  });
}

/**
 * Corps des commentaires de la cible, ou `null` si la lecture a échoué.
 *
 * @param {Readonly<object>} config
 * @param {Readonly<object>} cible rendue par `choisirCible`
 * @returns {string[]|null}
 */
function lireCommentaires(config, cible) {
  let reponse;
  try {
    reponse = gh(
      [cible.type, 'view', String(cible.numero), '--repo', config.depot, '--json', 'comments'],
      { json: true, tolererEchec: true },
    );
  } catch (err) {
    avertir(
      `Lecture des commentaires de ${cible.libelle} impossible : ` +
        `${err && err.message ? err.message : err}`,
    );
    return null;
  }
  if (reponse === null || typeof reponse !== 'object' || !Array.isArray(reponse.comments)) {
    return null;
  }
  return reponse.comments.map((c) => (c && typeof c.body === 'string' ? c.body : ''));
}

/**
 * Un compte rendu de CE run est-il déjà publié — sur la cible, ou sur l'autre
 * candidat ?
 *
 * Trois valeurs, parce qu'il y a trois situations et que les confondre coûte soit un
 * doublon, soit un silence : marqueur trouvé, marqueur absent des DEUX côtés, et
 * lecture impossible — ce dernier cas n'est PAS « absent », sinon une panne de lecture
 * vaudrait « rien n'a été publié ».
 *
 * DEUX CANDIDATS, PAS UN. `publierCompteRendu` poste sur la PR ou sur l'issue selon
 * `bilan.numeroPr` (`scripts/resolve.js`), et la cible calculée ici n'est pas toujours
 * celle qu'il a choisie : `numeroPrDeLaBranche` résout la PR en `--state all`, donc une
 * PR FERMÉE d'un run antérieur compte comme existante. Chemin atteignable — la garde ne
 * refuse que les PR ouvertes (`scripts/garde.js`) : PR d'un run précédent fermée sans
 * suppression de branche, puis un run où `resolve.js` publie sur l'issue (chemin R4, ou
 * mort avant le push). En ne lisant que la cible, ce script ne trouvait sur la PR fermée
 * que le marqueur du run d'AVANT, et publiait un doublon affirmant « l'action s'est
 * arrêtée sans publier » sur un run qui venait de publier. D'où l'issue en second
 * candidat quand la cible est la PR ; quand la cible est déjà l'issue, il n'y a pas
 * d'autre candidat à consulter, la PR n'étant pas connue.
 *
 * LA SECONDE LECTURE N'A LIEU QUE SI LA PREMIÈRE N'A PAS TROUVÉ LE MARQUEUR. C'est une
 * contrainte de conception, pas une optimisation : le marqueur trouvé sur la cible
 * tranche à lui seul, et lire les deux côtés systématiquement ferait tomber les cas
 * silencieux de `test/compte-rendu.test.js`, qui exigent UNE lecture avant un silence —
 * ce qui distingue « il a lu, puis décidé » de « il est mort avant de lire ». Ne pas
 * « simplifier » en lisant les deux côtés d'office.
 *
 * CAS MIXTE — marqueur absent d'un côté, lecture impossible de l'autre — tranché en
 * `null`, donc en « lecture impossible ». Les deux valeurs publient : l'arbitrage
 * général du script (« plutôt un doublon qu'un silence ») ne les sépare pas. Ce qui les
 * sépare est le CORPS publié, où `null` ajoute la phrase de réserve. Or la vérification
 * a réellement été partielle : affirmer « l'action s'est arrêtée sans publier de compte
 * rendu pour ce run » sans avoir su relire l'un des deux candidats serait une
 * affirmation que personne n'a contrôlée. La réserve est donc due.
 *
 * Une lecture impossible SUR LA CIBLE, elle, rend `null` tout de suite, sans consulter
 * le second candidat : la décision est déjà arrêtée — publier avec réserve — et rien de
 * ce qu'on lirait ensuite ne la changerait, `true` mis à part, que l'arbitrage
 * ci-dessus refuse justement de trancher à l'aveugle.
 *
 * @param {Readonly<object>} config
 * @param {Readonly<object>} cible rendue par `choisirCible`
 * @returns {boolean|null} `true` marqueur trouvé, `false` absent des deux côtés, `null`
 *   lecture impossible — l'appelant publie alors quand même, en le signalant.
 */
function compteRenduDejaPublie(config, cible) {
  const surLaCible = lireCommentaires(config, cible);
  if (surLaCible === null) return null;
  if (surLaCible.some((corps) => contientMarqueur(corps, config.porteeRun))) return true;

  // Pas de second candidat quand la cible est déjà l'issue : le numéro de la pull
  // request n'est pas connu — soit elle n'existe pas, soit `gh pr list` n'a pas
  // répondu, et le repli l'a déjà signalé.
  if (cible.type !== 'pr') return false;

  const autreCandidat = choisirCible(config, null);
  const surAutreCandidat = lireCommentaires(config, autreCandidat);
  if (surAutreCandidat === null) {
    // Le `::warning::` de `principal()` dit où le compte rendu part malgré tout ; il ne
    // dit pas QUELLE lecture a échoué, et il ne peut pas le dire — les deux candidats
    // peuvent tomber. C'est cette ligne-ci qui nomme le candidat non relu, sans quoi le
    // lecteur des logs chercherait la panne du côté de la cible, qui a répondu.
    avertir(
      `Les commentaires de ${autreCandidat.libelle} n'ont pas pu être relus : impossible ` +
        `de savoir si le compte rendu de ce run y est déjà.`,
    );
    return null;
  }
  return surAutreCandidat.some((corps) => contientMarqueur(corps, config.porteeRun));
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

/**
 * Écrit le corps dans un fichier temporaire et appelle `fn`.
 *
 * Même règle que `resolve.js` : `--body-file` toujours, `--body` jamais — un corps
 * de commentaire n'a rien à faire dans un argv. Hors du checkout (`os.tmpdir()`) :
 * un fichier écrit dans le répertoire de travail apparaîtrait dans `git status`.
 * `mkdtempSync` est DANS le `try` : un TMPDIR non inscriptible ne doit pas faire
 * lever la fonction qui porte le dernier message reçu par l'utilisateur.
 */
function avecFichierCorps(contenu, fn) {
  let repertoire = null;
  try {
    repertoire = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-resolve-secours-'));
    const fichier = path.join(repertoire, 'corps.md');
    fs.writeFileSync(fichier, masquerSecrets(contenu), 'utf8');
    return fn(fichier);
  } finally {
    if (repertoire !== null) {
      try {
        fs.rmSync(repertoire, { recursive: true, force: true });
      } catch {
        // Un temporaire non supprimé n'a aucune conséquence : le runner est jeté.
      }
    }
  }
}

/**
 * Publie le compte rendu de secours sur la cible.
 *
 * N'échoue jamais bruyamment : le corps est déjà dans le journal du job au moment où
 * cette fonction est appelée, et un `::error::` suffit à signaler l'échec sans
 * rougir le job.
 *
 * @returns {boolean} publié ou non
 */
function publierSecours(config, cible, corps) {
  const sousCommande = cible.type === 'pr' ? ['pr', 'comment'] : ['issue', 'comment'];
  let reponse = null;
  try {
    reponse = avecFichierCorps(corps, (fichier) =>
      gh(
        [...sousCommande, String(cible.numero), '--repo', config.depot, '--body-file', fichier],
        { tolererEchec: true },
      ),
    );
  } catch (err) {
    erreur(
      `Le compte rendu de secours n'a pas pu être préparé pour ${cible.libelle} : ` +
        `${err && err.message ? err.message : err}. Il reste dans les logs du job.`,
    );
    return false;
  }
  if (reponse === null) {
    erreur(
      `Le compte rendu de secours n'a pas pu être publié sur ${cible.libelle}. Vérifier que ` +
        "le jeton github-token porte les droits d'écriture sur les issues et les pull " +
        'requests. Il reste dans les logs du job.',
    );
    return false;
  }
  journaliser(`Compte rendu de secours publié sur ${cible.libelle}.`);
  return true;
}

// ---------------------------------------------------------------------------
// Point d'entrée
// ---------------------------------------------------------------------------

/**
 * @returns {number} toujours 0 — voir l'en-tête du fichier
 */
function principal() {
  let config;
  try {
    config = lireConfiguration();
  } catch (err) {
    // Refus, pas panne : le motif nomme l'entrée fautive pour être exploitable par
    // le lecteur des logs, et le job garde le verdict rendu par `resolve.js`.
    erreur(err && err.message ? err.message : String(err));
    return 0;
  }

  // Construit SANS le drapeau de dégradation : à ce stade, aucune lecture n'a eu lieu,
  // donc rien ne permet de dire qu'elle a échoué. Les deux chemins qui journalisent le
  // corps sans jamais lire — `no-publish` et jeton absent — se servent de celui-ci ;
  // le corps réellement publié est reconstruit plus bas, une fois la lecture faite.
  const corps = construireCorpsSecours(config);

  // Même règle que `publierCompteRendu` : sous `no-publish`, le compte rendu va dans
  // le journal du job et nulle part ailleurs.
  if (config.sansPublication) {
    journaliser(`no-publish : compte rendu de secours non publié.\n${corps}`);
    return 0;
  }

  if (config.jetonGh === '') {
    // Journalisé quand même, avant l'erreur : c'est le dernier message que
    // l'utilisateur puisse recevoir, et il ne doit dépendre ni d'un jeton ni du réseau.
    journaliser(corps);
    erreur(
      "GH_TOKEN est absent : la publication du compte rendu de secours est impossible. " +
        "Renseigner l'input github-token (défaut ${{ github.token }}). Le compte rendu " +
        'ci-dessus reste dans les logs du job.',
    );
    return 0;
  }

  const cible = choisirCible(config, numeroPrDeLaBranche(config));
  const deja = compteRenduDejaPublie(config, cible);

  // Le SEUL critère de silence : un compte rendu de ce run est déjà là. `resolve.js`
  // sort en 0 y compris quand `max-iterations` est atteint sans que la validation
  // passe — mais dans ce cas il a publié son compte rendu lui-même, avec le compte de
  // tours et la cause que ce script n'a pas, et c'est son marqueur qu'on trouve ici.
  if (deja === true) {
    // Sans nommer de cible : le compte rendu trouvé peut être sur la pull request comme
    // sur l'issue (`compteRenduDejaPublie` consulte les deux), et affirmer la mauvaise
    // des deux enverrait le lecteur des logs chercher un commentaire là où il n'est pas.
    // Les deux lectures figurent de toute façon dans le journal du job, avec leur argv.
    journaliser('Un compte rendu de ce run est déjà publié : rien à republier.');
    return 0;
  }
  if (deja === null) {
    // Nomme la cible de PUBLICATION, pas la lecture qui a échoué : celle qui a échoué
    // peut être l'autre candidat, et c'est `compteRenduDejaPublie` qui le dit alors,
    // juste avant. Ce message-ci répond à « pourquoi ce commentaire porte une réserve ».
    avertir(
      `Le compte rendu de secours part sur ${cible.libelle} sans avoir pu vérifier ` +
        "l'absence de doublon : une lecture des commentaires n'a pas abouti.",
    );
  }

  // Reconstruit avec le drapeau : le corps publié doit dire s'il a été publié à
  // l'aveugle. Un `::warning::` dans les logs du job ne suffit pas — le lecteur du
  // commentaire, lui, ne les ouvre pas forcément.
  const corpsAPublier =
    deja === null ? construireCorpsSecours(config, { verificationImpossible: true }) : corps;

  journaliser(corpsAPublier);
  publierSecours(config, cible, corpsAPublier);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = principal();
  } catch (err) {
    // `principal()` est écrite pour ne jamais lever. Ce filet existe pour que même
    // un défaut de ce script-là — le dernier du job — ne rougisse pas un job dont la
    // validation est passée.
    erreur(
      `Défaut interne de rendre-compte.js : ${err && err.message ? err.message : String(err)}`,
    );
    process.exitCode = 0;
  }
}

// Exportées pour `test/compte-rendu.test.js`, qui exerce la forme du marqueur et sa
// portée directement, et tout le reste en lançant le script — c'est ce qui permet
// d'asserter le code de sortie, l'argv réel et les annotations du job, qu'un appel de
// fonction ne montre pas. Les autres exports sont là pour qu'un cas futur puisse
// attaquer une fonction seule sans reconstruire l'environnement du runner : c'est
// possible parce que `config` est passé en argument plutôt que lu dans un état de
// module.
module.exports = {
  MARQUEUR_COMPTE_RENDU,
  porteeDuRun,
  marqueurCompteRendu,
  lireConfiguration,
  construireCorpsSecours,
  contientMarqueur,
  numeroPrDeLaBranche,
  choisirCible,
  lireCommentaires,
  compteRenduDejaPublie,
  publierSecours,
  principal,
};
