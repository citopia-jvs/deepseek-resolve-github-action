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
// Il est IDEMPOTENT : il ne republie rien si `resolve.js` a déjà publié le sien,
// reconnu à son marqueur — figé dans `plan/contrat.md`, invisible dans le rendu
// GitHub, et écrit par nous, pas par un tiers. Son propre compte rendu porte le même
// marqueur : deux exécutions du step (reprise de job, relance manuelle) ne doivent
// pas laisser deux commentaires.
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
const { masquerSecrets, tronquer } = require('./lib/texte.js');

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
    // `${{ job.status }}` : « success », « failure » ou « cancelled ». Laissé en
    // chaîne brute — c'est la valeur du runner, et toute autre valeur est traitée
    // comme un statut inattendu plutôt que devinée.
    statutJob: lireEnv('STATUT_JOB'),
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

const LONGUEUR_MAX_STATUT_CITE = 40;

/**
 * Rend une valeur d'environnement citable dans un commentaire public.
 *
 * `STATUT_JOB` vient du runner, mais rien ne garantit sa forme : elle est masquée
 * (les logs et les commentaires d'un dépôt public sont lus par tout le monde),
 * ramenée sur une ligne, débarrassée des caractères qui refermeraient le span de
 * code où elle est insérée, puis bornée.
 */
function citerValeur(valeur) {
  const propre = masquerSecrets(String(valeur))
    .replace(/\s+/g, ' ')
    .replace(/[`|<>]/g, ' ')
    .trim();
  if (propre === '') return '(vide)';
  // Le marqueur de `tronquer` porte des retours à la ligne : mesuré, un statut trop
  // long faisait sortir la phrase du span de code où elle est insérée, et la suite
  // était rendue en markdown. On remet sur une ligne APRÈS la troncature.
  return tronquer(propre, LONGUEUR_MAX_STATUT_CITE).replace(/\s+/g, ' ');
}

/**
 * Une phrase, factuelle, adaptée au statut du job.
 *
 * Le script ne sait rien de plus que ce statut : il n'a ni les itérations, ni la
 * sortie d'aider, ni les logs de validation — `resolve.js` est mort avant de les
 * lui transmettre. Promettre davantage ferait chercher au mauvais endroit.
 */
function phraseDuStatut(statutJob) {
  if (statutJob === 'cancelled') {
    return (
      '⚠️ Le job a été annulé, ou son délai d\'exécution a été dépassé, avant que ' +
      "l'action ait pu publier son compte rendu."
    );
  }
  if (statutJob === 'failure') {
    return "❌ Le job a échoué avant que l'action ait pu publier son compte rendu.";
  }
  return (
    `⚠️ Le job s'est terminé sur un statut inattendu (\`${citerValeur(statutJob)}\`) avant ` +
    "que l'action ait pu publier son compte rendu."
  );
}

/**
 * Construit le corps du compte rendu de secours.
 *
 * Aucun texte tiers n'y entre : ni titre, ni corps d'issue, ni sortie de
 * sous-processus. La seule valeur venue de l'extérieur est `STATUT_JOB`, qui passe
 * par `citerValeur`.
 *
 * @param {Readonly<object>} config
 * @returns {string} corps markdown, terminé par le marqueur
 */
function construireCorpsSecours(config) {
  const lignes = [phraseDuStatut(config.statutJob)];

  lignes.push('');
  lignes.push(
    "Ce message est publié par le filet de sécurité de l'action, pas par sa boucle de " +
      "résolution : celle-ci ne s'est pas rendue jusqu'à son propre compte rendu, et " +
      "l'état exact du travail n'est donc pas connu ici.",
  );

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
 * le compte rendu de `resolve.js`, et le chercher côté issue le republierait. Sur
 * plusieurs PR pour la même branche, la plus récente est celle du run courant, donc
 * le plus grand numéro.
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
 * Cible de lecture et de publication : la pull request si elle existe, l'issue
 * sinon. C'est exactement le choix de `publierCompteRendu`, qui poste sur l'une ou
 * sur l'autre selon `bilan.numeroPr` — chercher d'un seul côté republierait sur le
 * chemin R4, où le compte rendu part sur l'issue.
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
 * Un compte rendu est-il déjà publié sur la cible ?
 *
 * Trois valeurs, parce qu'il y a trois situations et que les confondre coûte soit un
 * doublon, soit un silence : marqueur trouvé, marqueur absent, et lecture impossible —
 * ce dernier cas n'est PAS « absent », sinon une panne de lecture vaudrait « rien n'a
 * été publié ».
 *
 * @param {Readonly<object>} config
 * @param {Readonly<object>} cible
 * @returns {boolean|null} `true` marqueur trouvé, `false` absent, `null` lecture
 *   impossible — l'appelant publie alors quand même, en le signalant.
 */
function compteRenduDejaPublie(config, cible) {
  const commentaires = lireCommentaires(config, cible);
  if (commentaires === null) return null;
  return commentaires.some((corps) => contientMarqueur(corps, config.porteeRun));
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

  const corps = construireCorpsSecours(config);

  // Même règle que `publierCompteRendu` : sous `no-publish`, le compte rendu va dans
  // le journal du job et nulle part ailleurs.
  if (config.sansPublication) {
    // La réserve est écrite AVANT le corps, pas après : « statut inattendu (success) »
    // suivi d'un démenti se lit à l'envers, et le lecteur des logs croit le premier
    // des deux.
    const reserve =
      config.statutJob === 'success'
        ? ' Le statut du job est « success » : rien n\'aurait été publié de toute façon.'
        : '';
    journaliser(`no-publish : compte rendu de secours non publié.${reserve}\n${corps}`);
    return 0;
  }

  // `resolve.js` sort en 0 y compris quand `max-iterations` est atteint sans que la
  // validation passe : dans ce cas il a publié son compte rendu lui-même, avec le
  // compte de tours et la cause que ce script n'a pas. La décision est journalisée,
  // sinon un lecteur de logs ne comprend pas le silence de ce step.
  if (config.statutJob === 'success') {
    journaliser(
      'Statut du job « success » : le compte rendu a été publié par la boucle. Rien à ' +
        'publier ici.',
    );
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

  if (deja === true) {
    journaliser(
      `Un compte rendu est déjà présent sur ${cible.libelle} : rien à republier.`,
    );
    return 0;
  }
  if (deja === null) {
    avertir(
      `Les commentaires de ${cible.libelle} n'ont pas pu être relus : le compte rendu de ` +
        'secours est publié sans avoir pu vérifier l\'absence de doublon.',
    );
  }

  journaliser(corps);
  publierSecours(config, cible, corps);
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
  phraseDuStatut,
  citerValeur,
  contientMarqueur,
  numeroPrDeLaBranche,
  choisirCible,
  lireCommentaires,
  compteRenduDejaPublie,
  publierSecours,
  principal,
};
