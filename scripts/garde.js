#!/usr/bin/env node
'use strict';

// Garde d'entrée de l'action. Décide si le reste du job doit tourner.
//
// Tourne AVANT l'installation d'aider : un commentaire sans « @dseek » coûte
// alors quelques centaines de millisecondes au lieu d'une minute de runner.
//
// Trois règles de comportement, non négociables :
//
//   1. Le script sort TOUJOURS en code 0, refus compris. Un refus n'est pas une
//      panne : un job rouge à chaque commentaire anodin rendrait le dépôt
//      illisible. Le refus s'exprime par la sortie « poursuivre=false ».
//   2. Les sorties sont écrites DÈS le premier refus, jamais seulement en fin de
//      script — sinon un refus précoce laisse « poursuivre » vide et le `if:` des
//      steps suivants devient indéterminé.
//   3. Toute exception non prévue vaut « poursuivre=false », par intention et non
//      par accident : l'étage 2 de l'autorisation fait un appel réseau, et un
//      timeout ne doit jamais valoir « autorisé » (fail-closed).
//
// Ce que cette garde fait : contrôler QUI déclenche.
// Ce qu'elle ne fait pas : contrôler le TEXTE de la consigne. Le corps de l'issue
// peut avoir été rédigé par quelqu'un d'autre que l'auteur du « @dseek » — c'est
// même le cas nominal. Voir R6 dans plan/README.md, traité au lot 3b.
//
// Bibliothèque standard uniquement, CommonJS : aucune dépendance.

const fs = require('node:fs');

const { gh } = require('./lib/gh.js');
const { nettoyerTexteTiers, masquerSecrets, tronquer } = require('./lib/texte.js');

// Liste blanche d'événements. Contrôle explicite, et non déduction de la forme du
// payload : un consommateur qui écrirait `on: pull_request_target` sans avoir lu le
// README doit être refusé par une règle, pas par effet de bord.
const EVENEMENTS_AUTORISES = ['issues', 'issue_comment'];

const MENTION = '@dseek';

// Étage 1 de l'autorisation : valeur calculée par GitHub, non falsifiable, gratuite.
const ASSOCIATIONS_PAR_DEFAUT = 'OWNER,MEMBER,COLLABORATOR';

// Étage 2 : la permission effective. `author_association` n'est PAS une permission
// (MEMBER = membre de l'organisation, COLLABORATOR inclut read et triage).
const PERMISSIONS_SUFFISANTES = ['write', 'maintain', 'admin'];

const BRANCHE_VALIDE = /^fix-issue-\d+$/;

// Login GitHub : 39 caractères alphanumériques ou tirets, plus le suffixe « [bot] »
// des comptes d'application. Les arguments partent dans un tableau, jamais dans un
// shell, donc l'injection est déjà fermée : ce contrôle ferme la construction d'un
// chemin d'API absurde, et vaut refus (fail-closed).
const LOGIN_VALIDE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

// `consigne-restreinte` : voir l'étage 2 bis. Écrite sur TOUS les chemins, à
// « false » par défaut — une sortie absente vaut la chaîne vide côté consommateur,
// et '' !== 'false' est le genre de piège qu'on paie plus tard.
//
// `motif` peut contenir un retour à la ligne (troncature, message d'erreur) : il
// s'écrit donc sous la forme à délimiteur de GITHUB_OUTPUT.
const DELIMITEUR_MOTIF = 'EOF_MOTIF';
const LONGUEUR_MAX_MOTIF = 500;

// ─── Journalisation ──────────────────────────────────────────────────────────
// Tout ce qui est journalisé passe par masquerSecrets : les logs d'un job sont
// publics sur un dépôt public, et un motif peut recopier un fragment de payload.

function journaliser(message) {
  console.log(masquerSecrets(String(message)));
}

// Les commandes de workflow (`::debug::`, `::warning::`) prennent leur message sur
// UNE ligne : un retour à la ligne non échappé tronque l'annotation.
function echapperCommande(message) {
  return String(message)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

function deboguer(message) {
  console.log(`::debug::${echapperCommande(masquerSecrets(String(message)))}`);
}

function avertir(message) {
  console.log(`::warning::${echapperCommande(masquerSecrets(String(message)))}`);
}

// ::error:: annote le job sans le faire échouer : c'est exactement ce qu'il faut
// pour signaler une écriture de sortie impossible sans contredire la règle
// « code 0 sur tous les chemins ».
function erreur(message) {
  console.log(`::error::${echapperCommande(masquerSecrets(String(message)))}`);
}

// ─── Sorties ─────────────────────────────────────────────────────────────────

// Vrai dès que le bloc de sorties est parti. Sert au filet de sécurité final :
// une exception survenue APRÈS la décision ne doit pas écrire un second bloc
// contradictoire.
let sortiesEcrites = false;

/**
 * Écrit les cinq sorties du contrat dans GITHUB_OUTPUT, en un seul bloc.
 * @param {{ poursuivre: boolean, issue?: string|number, branche?: string,
 *           consigneRestreinte?: boolean, motif?: string }} decision
 */
function ecrireSorties({
  poursuivre,
  issue = '',
  branche = '',
  consigneRestreinte = false,
  motif = '',
}) {
  // masquerSecrets n'est PAS une précaution superflue, ne pas le retirer : un motif
  // recopie un message d'erreur de « gh » ou de « git », et l'argv de ces commandes
  // peut porter un jeton. Le motif est republié dans le compte rendu de PR (lot 4),
  // et les logs d'un job sont publics sur un dépôt public (R7). ::add-mask:: ne
  // couvre pas ce chemin : il ne remplace que l'occurrence littérale exacte.
  //
  // tronquer borne la valeur : « motif » est décrit comme une chaîne COURTE au
  // contrat, et il finit dans un commentaire de PR.
  let valeurMotif = tronquer(masquerSecrets(String(motif)), LONGUEUR_MAX_MOTIF);

  // Neutralisation du délimiteur, à ne pas retirer non plus : une ligne valant
  // exactement EOF_MOTIF dans la valeur fermerait le bloc en avance, et la suite
  // du motif serait alors interprétée par le runner comme d'autres paires
  // « clé=valeur » — c'est-à-dire une injection de sortie. Les motifs sont écrits
  // ici, mais ils recopient des données de payload rédigées par un tiers.
  valeurMotif = valeurMotif.split(DELIMITEUR_MOTIF).join('fin-de-motif');

  const bloc =
    [
      `poursuivre=${poursuivre ? 'true' : 'false'}`,
      `issue=${issue === '' ? '' : String(issue)}`,
      `branche=${branche}`,
      `consigne-restreinte=${consigneRestreinte ? 'true' : 'false'}`,
      // Le bloc à délimiteur vient en dernier : une paire clé=valeur écrite après
      // lui serait avalée par la valeur si le délimiteur se fermait mal.
      `motif<<${DELIMITEUR_MOTIF}`,
      valeurMotif,
      DELIMITEUR_MOTIF,
    ].join('\n') + '\n';

  const fichier = process.env.GITHUB_OUTPUT;
  if (fichier) {
    try {
      // GITHUB_OUTPUT est héritée par le process Node enfant : un appendFileSync suffit.
      fs.appendFileSync(fichier, bloc);
    } catch (err) {
      // Le fichier peut être illisible : variable pointant un répertoire (EISDIR),
      // parent inexistant (ENOENT), droits (EACCES), step précédent qui a bricolé
      // le fichier. Laisser filer l'exception ferait sortir le script en code 1 —
      // donc rougir le job sur un commentaire anodin, avec une cause affichée qui
      // n'a rien à voir avec la décision de la garde. C'est le fail-closed PAR
      // ACCIDENT que ce lot condamne : on journalise et on continue.
      erreur(
        `Écriture de GITHUB_OUTPUT (${fichier}) impossible : ${err && err.message ? err.message : err}. Les sorties de la garde sont perdues, le job va probablement s'arrêter au « if: » du step suivant.`,
      );
      journaliser(`Sorties qui n'ont pas pu être écrites :\n${bloc}`);
    }
  } else {
    // Exécution hors runner (essai à la main) : ne pas planter, afficher.
    journaliser(`GITHUB_OUTPUT absente, sorties non écrites :\n${bloc}`);
  }
  // Vrai même si l'écriture a échoué : la décision a été émise une fois pour
  // toutes. Réessayer depuis le filet final rejouerait la même erreur de système
  // de fichiers et risquerait d'écrire un second bloc contradictoire.
  sortiesEcrites = true;
}

/** Signal interne de refus. Sert à dérouler la pile sans process.exit(). */
class Refus extends Error {}

/**
 * Refuse, écrit les sorties immédiatement, et interrompt le script.
 * `consigne-restreinte` vaut toujours « false » sur un refus : rien ne partira
 * vers aider, la question ne se pose pas, et le bloc garde une forme constante.
 * @param {string} motif
 * @param {{ issue?: string|number, branche?: string, niveau?: 'log'|'debug'|'avertissement' }} [options]
 * @returns {never}
 */
function refuser(motif, { issue = '', branche = '', niveau = 'log' } = {}) {
  const message = `Refus : ${motif}`;
  if (niveau === 'debug') deboguer(message);
  else if (niveau === 'avertissement') avertir(message);
  else journaliser(message);

  ecrireSorties({ poursuivre: false, issue, branche, motif });
  throw new Refus(motif);
}

// ─── Lecture de la configuration ─────────────────────────────────────────────
// Tous les inputs d'action sont des CHAÎNES, et une composite action ne les expose
// pas en INPUT_*. On ne compare qu'à 'true', jamais à 'false'.

function associationsAutorisees() {
  const brut = String(process.env.ASSOCIATIONS_AUTORISEES || '').trim() || ASSOCIATIONS_PAR_DEFAUT;
  const liste = brut
    .split(',')
    .map((valeur) => valeur.trim().toUpperCase())
    .filter((valeur) => valeur !== '');
  // Une liste vide (input rempli d'espaces et de virgules) ne doit pas tout
  // autoriser par accident : on retombe sur le défaut.
  return liste.length > 0 ? liste : ASSOCIATIONS_PAR_DEFAUT.split(',');
}

function exigerAuteurIssueDeConfiance() {
  const brut = process.env.EXIGER_AUTEUR_ISSUE_DE_CONFIANCE;
  // Défaut 'true' quand la variable est absente ou vide.
  const valeur = brut === undefined || String(brut).trim() === '' ? 'true' : String(brut).trim();
  return valeur.toLowerCase() === 'true';
}

function contientMention(texte) {
  return String(texte).toLowerCase().includes(MENTION);
}

// ─── Étage 2 : la permission effective ───────────────────────────────────────

/**
 * Permission effective d'un compte sur ce dépôt, ou `null` si elle n'a pas pu être
 * établie. `null` doit TOUJOURS valoir refus : erreur réseau, 404 (non
 * collaborateur), réponse inattendue — aucun de ces cas n'est une autorisation.
 * @param {string} login
 * @param {string} depot `proprietaire/depot`
 * @returns {string|null} permission en minuscules, ou null
 */
function permissionEffective(login, depot) {
  if (!LOGIN_VALIDE.test(login)) {
    journaliser(`Login « ${login} » non conforme : permission tenue pour indéterminée.`);
    return null;
  }

  let reponse;
  try {
    // 404 pour un non-collaborateur : c'est une réponse, pas une panne, d'où
    // tolererEchec. Un échec de LANCEMENT de `gh` lève malgré tolererEchec — il
    // est rattrapé ici et vaut également refus.
    reponse = gh(['api', `repos/${depot}/collaborators/${login}/permission`, '--jq', '.permission'], {
      tolererEchec: true,
    });
  } catch (err) {
    journaliser(
      `Contrôle de permission impossible pour @${login} : ${err && err.message ? err.message : err}`,
    );
    return null;
  }

  if (typeof reponse !== 'string' || reponse.trim() === '') return null;
  return reponse.trim().toLowerCase();
}

function permissionSuffisante(permission) {
  return typeof permission === 'string' && PERMISSIONS_SUFFISANTES.includes(permission);
}

// ─── Réaction 👀 ─────────────────────────────────────────────────────────────

/**
 * Pose la réaction 👀. Uniquement après l'autorisation : accuser réception d'une
 * demande qui ne sera pas traitée est trompeur.
 *
 * LES DEUX ENDPOINTS SONT DIFFÉRENTS. Le code supprimé au lot 0 les confondait et
 * postait la réaction d'un commentaire sur l'endpoint des issues.
 */
function poserReaction({ estCommentaire, idCommentaire, numeroIssue, depot }) {
  let chemin;
  if (estCommentaire) {
    if (!Number.isInteger(idCommentaire) || idCommentaire <= 0) {
      journaliser(
        `Identifiant de commentaire inutilisable (${JSON.stringify(idCommentaire)}) : réaction 👀 non posée.`,
      );
      return;
    }
    // Endpoint COMMENTAIRE — noter « issues/comments/<id_du_commentaire> ».
    chemin = `repos/${depot}/issues/comments/${idCommentaire}/reactions`;
  } else {
    // Endpoint ISSUE — « issues/<numéro_d_issue> », sans « comments ».
    chemin = `repos/${depot}/issues/${numeroIssue}/reactions`;
  }

  const reponse = gh(['api', '--method', 'POST', chemin, '-f', 'content=eyes'], {
    tolererEchec: true,
  });
  if (reponse === null) {
    journaliser(`Réaction 👀 refusée par l'API sur ${chemin} — sans conséquence sur la suite.`);
  } else {
    deboguer(`Réaction 👀 posée sur ${chemin}.`);
  }
}

// ─── Séquence ────────────────────────────────────────────────────────────────

function principal() {
  // 1. Liste blanche d'événements. Première décision du script.
  const nomEvenement = String(process.env.GITHUB_EVENT_NAME || '').trim();
  if (!EVENEMENTS_AUTORISES.includes(nomEvenement)) {
    refuser(
      `événement « ${nomEvenement || '(absent)'} » non pris en charge, seuls ${EVENEMENTS_AUTORISES.join(' et ')} le sont.`,
    );
  }

  const depot = String(process.env.GITHUB_REPOSITORY || '').trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(depot)) {
    refuser(`GITHUB_REPOSITORY absente ou mal formée (${JSON.stringify(depot)}).`);
  }

  // 2. Lire l'événement.
  const cheminEvenement = String(process.env.GITHUB_EVENT_PATH || '').trim();
  if (cheminEvenement === '') refuser('GITHUB_EVENT_PATH absente : aucun payload à lire.');

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(cheminEvenement, 'utf8'));
  } catch (err) {
    refuser(
      `payload d'événement illisible (${cheminEvenement}) : ${err && err.message ? err.message : err}`,
    );
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    refuser("payload d'événement inattendu : un objet JSON était attendu.");
  }

  const issue = payload.issue;
  const commentaire = payload.comment;
  const aIssue = issue !== null && typeof issue === 'object' && !Array.isArray(issue);
  const aCommentaire =
    commentaire !== null && typeof commentaire === 'object' && !Array.isArray(commentaire);

  let estCommentaire;
  if (aCommentaire) {
    // `issue_comment` : le numéro d'issue vient de payload.issue.
    if (!aIssue) refuser("forme de payload inattendue : un « comment » sans « issue ».");
    estCommentaire = true;
  } else if (aIssue) {
    estCommentaire = false;
  } else {
    refuser("forme de payload inattendue : ni « issue » ni « comment ».");
  }

  // 3. Refuser les pull requests. Ne sert que pour `issue_comment` : sur un
  // événement `pull_request`, payload.issue est absent et l'étape 1 a déjà refusé.
  if (issue.pull_request) {
    refuser(
      "l'objet commenté est une pull request, pas une issue ; cette action ne traite que les issues.",
    );
  }

  const source = estCommentaire ? commentaire : issue;
  // nettoyerTexteTiers avant toute recherche : la mention doit être celle que le
  // lecteur voit. Un « @dseek » caché dans un <!-- … --> ou fabriqué avec des
  // caractères de largeur nulle ne doit pas décider à la place d'un humain (R6).
  const texte = nettoyerTexteTiers(typeof source.body === 'string' ? source.body : '');
  const acteur = String((source.user && source.user.login) || '').trim();
  const association = String(source.author_association || '')
    .trim()
    .toUpperCase();

  // 4. Anti-rejeu (R10). `types: [edited]` relance sinon un cycle complet à chaque
  // édition d'un texte qui contenait déjà la mention : un compte autorisé qui édite
  // en boucle vide la clé DeepSeek.
  if (payload.action === 'edited') {
    // Texte BRUT, sans nettoyage, contrairement au texte courant. Ce contrôle
    // répond à « la mention était-elle déjà là ? », pas à « était-elle visible ? ».
    // Nettoyer ici inverserait son sens : un ancien « <!-- @dseek --> » devenu
    // « @dseek » en clair passerait pour une demande nouvelle alors que le contenu
    // textuel n'a pas bougé. Au moindre doute sur la nouveauté, on refuse.
    const ancien =
      payload.changes && payload.changes.body && typeof payload.changes.body.from === 'string'
        ? payload.changes.body.from
        : '';
    if (contientMention(ancien)) {
      refuser(
        `édition d'un texte qui mentionnait déjà ${MENTION} : la demande n'est pas nouvelle, rien à traiter.`,
      );
    }
  }

  // Cas de très loin le plus fréquent : refus silencieux, en debug.
  if (!contientMention(texte)) {
    refuser(`aucune mention ${MENTION} dans le texte de l'événement ${nomEvenement}.`, {
      niveau: 'debug',
    });
  }

  // 5. Autoriser — étage 1, gratuit et non falsifiable.
  const autorisees = associationsAutorisees();
  if (!autorisees.includes(association)) {
    refuser(
      `@${acteur || '(inconnu)'} a l'association « ${association || '(absente)'} », absente de la liste autorisée (${autorisees.join(', ')}).`,
      { niveau: 'avertissement' },
    );
  }

  // Étage 2, obligatoire : `author_association` n'est pas une permission.
  if (acteur === '') refuser("acteur introuvable dans le payload : permission incontrôlable.");
  const permission = permissionEffective(acteur, depot);
  if (permission === null) {
    refuser(
      `permission effective de @${acteur} indéterminée (compte non collaborateur, ou appel API en échec) : refus par sécurité.`,
      { niveau: 'avertissement' },
    );
  }
  if (!permissionSuffisante(permission)) {
    refuser(
      `permission « ${permission} » de @${acteur} insuffisante : write, maintain ou admin exigée. Élargir « allowed-associations » ne corrigerait rien, c'est bien la permission qui manque.`,
      { niveau: 'avertissement' },
    );
  }

  // Étage 2 bis : l'auteur de l'issue n'est pas forcément l'auteur du « @dseek ».
  // S'il n'a pas le droit d'écriture, on ne refuse PAS : on passe en mode consigne
  // restreinte, où seul le texte du commentaire fait consigne et le corps de
  // l'issue est fourni en données non fiables. Atténuation de R6, pas barrière.
  let consigneRestreinte = false;
  if (estCommentaire && exigerAuteurIssueDeConfiance()) {
    const auteurIssue = String((issue.user && issue.user.login) || '').trim();
    if (auteurIssue === '') {
      consigneRestreinte = true;
      journaliser(
        "Auteur de l'issue introuvable dans le payload : mode consigne restreinte par précaution.",
      );
    } else if (auteurIssue !== acteur) {
      // Même compte que l'acteur : déjà contrôlé, on n'appelle pas l'API deux fois.
      const permissionAuteur = permissionEffective(auteurIssue, depot);
      if (!permissionSuffisante(permissionAuteur)) {
        consigneRestreinte = true;
        journaliser(
          `Mode consigne restreinte : l'auteur de l'issue @${auteurIssue} n'a pas de droit d'écriture (${permissionAuteur === null ? 'permission indéterminée' : `permission « ${permissionAuteur} »`}). Le corps de l'issue sera traité comme des données non fiables.`,
        );
      }
    }
  }

  // 6. Valider le numéro d'issue, puis la branche qui en dérive. Le coût est nul
  // et cela ferme l'injection d'argument dans les commandes du lot 3a.
  const numero = issue.number;
  if (!Number.isInteger(numero) || numero <= 0) {
    refuser(`numéro d'issue invalide : ${JSON.stringify(numero)}.`);
  }
  const branche = `fix-issue-${numero}`;
  if (!BRANCHE_VALIDE.test(branche)) {
    refuser(`nom de branche « ${branche} » non conforme à /^fix-issue-\\d+$/.`);
  }

  // 7. Le travail existe-t-il déjà ? Deux contrôles, une seule cause de refus.
  let prsOuvertes;
  try {
    prsOuvertes = gh(
      ['pr', 'list', '--repo', depot, '--head', branche, '--state', 'open', '--json', 'number'],
      { json: true },
    );
  } catch (err) {
    // État INDÉTERMINÉ, et le motif doit le dire : un humain lira ce texte dans le
    // compte rendu. Ne jamais laisser croire qu'une pull request a été trouvée.
    // Le détail technique est borné à part : sans cela, la troncature du motif
    // ampute la phrase que l'humain doit lire au profit du message de « gh ».
    const detail = tronquer(String(err && err.message ? err.message : err), 150);
    refuser(
      `impossible de savoir si une pull request est déjà ouverte sur ${branche} : « gh pr list » a échoué, l'état est indéterminé — ce n'est PAS « une PR existe ». Refus par sécurité, pour ne pas risquer une seconde pull request concurrente. Détail : ${detail}`,
      { issue: numero, branche },
    );
  }
  if (Array.isArray(prsOuvertes) && prsOuvertes.length > 0) {
    const numeros = prsOuvertes
      .map((pr) => `#${pr && pr.number !== undefined ? pr.number : '?'}`)
      .join(', ');
    refuser(
      `une pull request est déjà ouverte sur ${branche} (${numeros}) : commenter cette PR plutôt que relancer l'action.`,
      { issue: numero, branche },
    );
  }

  // La branche peut exister côté distant sans PR ouverte (PR fermée sans
  // suppression, run précédent annulé après le push). Ce n'est PAS un refus : le
  // lot 3a la reprend, c'est le traitement de R9. Contrôle informatif, journalisé.
  try {
    const reference = gh(['api', `repos/${depot}/git/ref/heads/${branche}`], {
      tolererEchec: true,
    });
    if (reference === null) {
      deboguer(`Aucune branche ${branche} côté distant.`);
    } else {
      journaliser(
        `La branche ${branche} existe déjà côté distant sans pull request ouverte : elle sera reprise, pas recréée (R9).`,
      );
    }
  } catch (err) {
    journaliser(
      `Contrôle de la branche distante ${branche} impossible, sans conséquence ici : ${err && err.message ? err.message : err}`,
    );
  }

  // 8. Écrire les sorties. `motif` reste vide quand on poursuit.
  ecrireSorties({ poursuivre: true, issue: numero, branche, consigneRestreinte, motif: '' });
  journaliser(
    `Poursuite autorisée : issue #${numero}, branche ${branche}, déclenchée par @${acteur} (${association}, permission « ${permission} »)${consigneRestreinte ? ', en mode consigne restreinte' : ''}.`,
  );

  // 9. Réaction 👀, en dernier : après l'autorisation, et sans pouvoir faire
  // échouer la garde.
  try {
    poserReaction({
      estCommentaire,
      idCommentaire: estCommentaire ? commentaire.id : null,
      numeroIssue: numero,
      depot,
    });
  } catch (err) {
    journaliser(`Réaction 👀 non posée : ${err && err.message ? err.message : err}`);
  }
}

// Filet de sécurité : fail-closed par intention. Une exception non prévue vaut
// refus, et le code de sortie reste 0 sur tous les chemins.
try {
  principal();
} catch (err) {
  if (!(err instanceof Refus)) {
    const motif = `exception non prévue dans la garde : ${err && err.message ? err.message : err}`;
    journaliser(`Refus : ${motif}`);
    if (err && err.stack) deboguer(String(err.stack));
    if (!sortiesEcrites) {
      // Rien n'a encore été écrit : la décision par défaut est le refus.
      // Ceinture et bretelles : ecrireSorties() ne lève plus, mais cet appel est
      // le DERNIER du script et il est hors de toute autre protection. Une
      // exception ici sortirait en code 1, ce qui est précisément interdit.
      try {
        ecrireSorties({ poursuivre: false, motif });
      } catch (err2) {
        erreur(
          `Écriture du refus de dernier recours impossible : ${err2 && err2.message ? err2.message : err2}`,
        );
      }
    } else {
      // La décision était déjà écrite (incident postérieur, par exemple sur la
      // réaction) : ne pas la contredire par un second bloc.
      journaliser('Sorties déjà écrites : la décision précédente est conservée.');
    }
  }
}

process.exitCode = 0;
