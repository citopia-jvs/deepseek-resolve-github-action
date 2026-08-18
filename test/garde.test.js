'use strict';

// Harnais de test de `scripts/garde.js` — lot 2.
//
// Node pur, bibliothèque standard uniquement (`node:test`, `node:assert`),
// CommonJS, aucune dépendance npm. Lancement :
//
//   node test/garde.test.js
//
// La garde n'est jamais chargée en module : elle est lancée en SOUS-PROCESSUS,
// avec un tableau d'arguments et jamais `shell: true`, exactement comme le runner
// le fait. C'est le seul moyen d'observer un code de sortie et un GITHUB_OUTPUT
// réels.
//
// ─── Ce que le socle commun contrôle sur CHAQUE cas ──────────────────────────
//
//   1. le code de sortie, qui vaut 0 partout, refus compris — un refus n'est pas
//      une panne ;
//   2. la valeur de `poursuivre` ;
//   3. la valeur de `consigne-restreinte`, à « false » sur les refus : le contrat
//      l'exige sur TOUS les chemins, et une sortie absente vaut '' côté
//      consommateur, or '' !== 'false' ;
//   4. l'ensemble EXACT des cinq clés du contrat. Une sortie en trop est le
//      symptôme d'un bloc à délimiteur refermé trop tôt, donc d'une injection.
//
// ─── Trois familles de cas ───────────────────────────────────────────────────
//
//   A. les dix fixtures du tableau du lot 2 — elles ne varient que par le
//      PAYLOAD ;
//   B. les garde-fous fail-closed, qui ne dépendent pas du payload mais de la
//      RÉPONSE de l'API : ils s'exercent avec les scénarios du stub `gh`, pas
//      avec des fixtures de plus ;
//   C. les validations d'entrée et la forme des sorties, qui demandent des
//      payloads volontairement malformés. Ceux-là sont écrits à la volée dans le
//      répertoire temporaire : ce ne sont pas des fixtures du plan, et
//      `__fixtures__/` doit rester exactement le tableau du lot 2.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RACINE = path.resolve(__dirname, '..');
const GARDE = path.join(RACINE, 'scripts', 'garde.js');
const FIXTURES = path.join(RACINE, '__fixtures__');

// Le stub versionné du lot 1, jamais `/bin/true` : avec un stdout vide,
// `JSON.parse('')` lève, la garde sort en code non nul et le cas nominal échoue
// en contredisant la règle « code 0 partout ». Chemin absolu : le stub doit être
// trouvé quel que soit le répertoire depuis lequel on lance le test.
const STUB_GH = path.join(FIXTURES, 'gh-stub.sh');

const DEPOT = 'proprietaire/depot';

// Les cinq sorties du contrat, ni plus ni moins.
const CLES_ATTENDUES = ['branche', 'consigne-restreinte', 'issue', 'motif', 'poursuivre'];

// Tout ce que le test écrit vit sous le répertoire temporaire du système, jamais
// dans le dépôt : un journal de stub oublié dans `__fixtures__/` finirait
// committé.
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'garde-test-'));

// ─── Lecture de GITHUB_OUTPUT ────────────────────────────────────────────────

/**
 * Lit un fichier GITHUB_OUTPUT, en gérant les deux formes : `clé=valeur` et le
 * bloc à délimiteur `clé<<MARQUE … MARQUE` que la garde emploie pour `motif`.
 *
 * Volontairement écrit comme le fait le runner : le délimiteur ne ferme le bloc
 * que s'il occupe une ligne ENTIÈRE. C'est ce qui rend observable l'injection
 * d'une sortie supplémentaire par un motif malveillant.
 * @param {string} fichier
 * @returns {Record<string, string>}
 */
function lireSorties(fichier) {
  const lignes = fs.readFileSync(fichier, 'utf8').split('\n');
  const sorties = {};

  for (let i = 0; i < lignes.length; i += 1) {
    const ligne = lignes[i];
    if (ligne === '') continue;

    const egal = ligne.indexOf('=');
    const chevrons = ligne.indexOf('<<');

    if (chevrons !== -1 && (egal === -1 || chevrons < egal)) {
      const cle = ligne.slice(0, chevrons);
      const marque = ligne.slice(chevrons + 2);
      const corps = [];
      i += 1;
      while (i < lignes.length && lignes[i] !== marque) {
        corps.push(lignes[i]);
        i += 1;
      }
      sorties[cle] = corps.join('\n');
    } else if (egal !== -1) {
      sorties[ligne.slice(0, egal)] = ligne.slice(egal + 1);
    }
  }

  return sorties;
}

// ─── Lecture du journal du stub `gh` ─────────────────────────────────────────

/**
 * Un appel = les arguments séparés par un NUL, suivis d'un « record separator ».
 * Format documenté en tête de `__fixtures__/gh-stub.sh`.
 * @param {string} journal
 * @returns {string[][]} un tableau d'arguments par appel
 */
function lireJournal(journal) {
  if (!fs.existsSync(journal)) return [];
  return fs
    .readFileSync(journal, 'utf8')
    .split('\x1e')
    .filter(Boolean)
    .map((appel) => appel.split('\0').filter((argument) => argument !== ''));
}

/** Les appels qui visent l'API des réactions. */
function appelsReaction(appels) {
  return appels.filter((args) => args.some((a) => a.endsWith('/reactions')));
}

/** Le chemin d'API `…/reactions` d'un appel. */
function cheminReaction(args) {
  return args.find((a) => a.endsWith('/reactions'));
}

/** Les appels `gh pr list`. */
function appelsPrList(appels) {
  return appels.filter((args) => args[0] === 'pr' && args[1] === 'list');
}

/** Les logins dont la permission effective a été demandée, dans l'ordre. */
function loginsControles(appels) {
  const prefixe = '/collaborators/';
  const suffixe = '/permission';
  return appels
    .map((args) => args.find((a) => a.includes(prefixe) && a.endsWith(suffixe)))
    .filter(Boolean)
    .map((chemin) => chemin.slice(chemin.indexOf(prefixe) + prefixe.length, -suffixe.length));
}

// ─── Lancement de la garde ───────────────────────────────────────────────────

/**
 * Écrit un payload d'événement à la volée. Réservé aux payloads volontairement
 * malformés : les payloads légitimes sont les fixtures versionnées.
 * @param {string} cas
 * @param {object} objet
 * @returns {string} chemin absolu
 */
function ecrirePayload(cas, objet) {
  const chemin = path.join(TEMP, `${cas}.payload.json`);
  fs.writeFileSync(chemin, JSON.stringify(objet, null, 2));
  return chemin;
}

/**
 * Lance `scripts/garde.js` en sous-processus, avec un GITHUB_OUTPUT et un
 * journal de stub PROPRES À CE CAS : deux cas qui partagent un journal mélangent
 * leurs appels, et deux cas qui partagent un GITHUB_OUTPUT lisent la décision du
 * voisin.
 * @param {string} cas identifiant du cas, sert à nommer les fichiers temporaires
 * @param {{ fixture?: string, payload?: string, evenement: string,
 *           env?: Record<string, string>,
 *           sorties?: 'fichier'|'repertoire'|'absente' }} options
 *   `sorties` : forme donnée à GITHUB_OUTPUT. « repertoire » la fait pointer sur
 *   un répertoire, donc `appendFileSync` lève EISDIR ; « absente » ne définit pas
 *   la variable. Dans ces deux cas il n'y a rien à relire, et `sorties` vaut
 *   `null` dans le résultat.
 */
function lancerGarde(cas, { fixture, payload, evenement, env = {}, sorties = 'fichier' }) {
  const cheminEvenement = fixture ? path.join(FIXTURES, fixture) : payload;
  assert.ok(cheminEvenement, 'lancerGarde attend « fixture » ou « payload »');

  let fichierSorties = null;
  if (sorties === 'fichier') {
    fichierSorties = path.join(TEMP, `${cas}.sorties`);
    fs.writeFileSync(fichierSorties, '');
  } else if (sorties === 'repertoire') {
    fichierSorties = path.join(TEMP, `${cas}.sorties-en-repertoire`);
    fs.mkdirSync(fichierSorties, { recursive: true });
  }

  const journal = path.join(TEMP, `${cas}.journal-gh`);

  // Environnement construit de zéro : la garde ne doit rien devoir à
  // l'environnement de la machine de développement.
  const resultat = spawnSync(process.execPath, [GARDE], {
    cwd: RACINE,
    encoding: 'utf8',
    // Jamais `shell: true` : un tableau d'arguments ferme l'injection de commande.
    shell: false,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME || TEMP,
      GITHUB_EVENT_NAME: evenement,
      GITHUB_EVENT_PATH: cheminEvenement,
      GITHUB_REPOSITORY: DEPOT,
      // Volontairement absente quand sorties === 'absente'.
      ...(fichierSorties === null ? {} : { GITHUB_OUTPUT: fichierSorties }),
      GH_TOKEN: 'jeton-de-test',
      GH_CLI: STUB_GH,
      GH_STUB_JOURNAL: journal,
      ...env,
    },
  });

  assert.equal(
    resultat.error,
    undefined,
    `lancement de la garde impossible : ${resultat.error && resultat.error.message}`,
  );

  return {
    resultat,
    sorties: sorties === 'fichier' ? lireSorties(fichierSorties) : null,
    appels: lireJournal(journal),
    // Utile quand une assertion tombe : sans les traces, un test rouge sur un
    // sous-processus ne dit rien.
    traces: `--- stdout ---\n${resultat.stdout}\n--- stderr ---\n${resultat.stderr}`,
  };
}

/**
 * Le socle commun, appliqué à TOUS les cas.
 * @param {object} execution
 * @param {'true'|'false'} poursuivreAttendu
 * @param {'true'|'false'} [consigneAttendue] « false » par défaut : c'est la
 *   valeur exigée sur tous les refus, et sur les poursuites hors étage 2 bis.
 */
function verifierSocle(execution, poursuivreAttendu, consigneAttendue = 'false') {
  const { resultat, sorties, traces } = execution;

  assert.equal(
    resultat.status,
    0,
    `la garde doit sortir en code 0 sur TOUS les chemins, refus compris ; ` +
      `obtenu ${resultat.status}\n${traces}`,
  );
  assert.equal(
    sorties.poursuivre,
    poursuivreAttendu,
    `poursuivre attendu « ${poursuivreAttendu} », obtenu ` +
      `${JSON.stringify(sorties.poursuivre)}\n${traces}`,
  );
  assert.equal(
    sorties['consigne-restreinte'],
    consigneAttendue,
    `consigne-restreinte attendue « ${consigneAttendue} » : le contrat l'exige sur ` +
      `tous les chemins, refus compris ; obtenu ` +
      `${JSON.stringify(sorties['consigne-restreinte'])}\n${traces}`,
  );
  assert.deepEqual(
    Object.keys(sorties).sort(),
    CLES_ATTENDUES,
    `le bloc de sorties doit porter exactement les cinq clés du contrat ; une clé ` +
      `en trop signale un bloc à délimiteur refermé trop tôt\n${traces}`,
  );
}

/** Un refus muet est indébogable : le motif doit être renseigné. */
function verifierMotifRenseigne(execution) {
  const { sorties, traces } = execution;
  assert.ok(
    typeof sorties.motif === 'string' && sorties.motif.trim() !== '',
    `un refus doit renseigner « motif » ; obtenu ${JSON.stringify(sorties.motif)}\n${traces}`,
  );
}

/** Accuser réception d'une demande qui ne sera pas traitée est trompeur. */
function verifierAucuneReaction(execution) {
  assert.equal(
    appelsReaction(execution.appels).length,
    0,
    `aucune réaction 👀 ne doit être posée sur un refus\n${execution.traces}`,
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// A. Les dix fixtures du tableau du lot 2
// ═════════════════════════════════════════════════════════════════════════════

test('issue-avec-dseek.json — issues, @dseek, OWNER : poursuit', () => {
  const execution = lancerGarde('issue-avec-dseek', {
    fixture: 'issue-avec-dseek.json',
    evenement: 'issues',
  });
  const { sorties, appels, traces } = execution;

  verifierSocle(execution, 'true');
  assert.equal(sorties.issue, '42', traces);
  assert.equal(sorties.branche, 'fix-issue-42', traces);
  assert.equal(sorties.motif, '', `« motif » doit rester vide quand on poursuit\n${traces}`);

  // Endpoint ISSUE : « issues/<numéro> », SANS « comments ». C'est l'erreur du
  // code supprimé au lot 0.
  const reactions = appelsReaction(appels);
  assert.equal(reactions.length, 1, `une seule réaction 👀 attendue\n${traces}`);
  assert.equal(cheminReaction(reactions[0]), `repos/${DEPOT}/issues/42/reactions`, traces);
  assert.ok(!cheminReaction(reactions[0]).includes('/comments/'), traces);
  assert.ok(reactions[0].includes('POST') && reactions[0].includes('content=eyes'), traces);
});

test("commentaire-avec-dseek.json — issue_comment, @dseek, OWNER : poursuit, et la réaction part sur l'endpoint COMMENTAIRE", () => {
  const execution = lancerGarde('commentaire-avec-dseek', {
    fixture: 'commentaire-avec-dseek.json',
    evenement: 'issue_comment',
  });
  const { sorties, appels, traces } = execution;

  verifierSocle(execution, 'true');
  assert.equal(sorties.issue, '7', traces);
  assert.equal(sorties.branche, 'fix-issue-7', traces);

  // Endpoint COMMENTAIRE : « issues/comments/<id_du_commentaire> ». L'identifiant
  // est celui du commentaire (2001), pas le numéro d'issue (7) : deux endpoints
  // différents, deux identifiants différents.
  const reactions = appelsReaction(appels);
  assert.equal(reactions.length, 1, `une seule réaction 👀 attendue\n${traces}`);
  assert.equal(
    cheminReaction(reactions[0]),
    `repos/${DEPOT}/issues/comments/2001/reactions`,
    `la réaction d'un commentaire ne doit pas partir sur l'endpoint des issues\n${traces}`,
  );
  assert.ok(reactions[0].includes('POST') && reactions[0].includes('content=eyes'), traces);
});

test('issue-sans-dseek.json — aucune mention : refuse', () => {
  const execution = lancerGarde('issue-sans-dseek', {
    fixture: 'issue-sans-dseek.json',
    evenement: 'issues',
  });

  verifierSocle(execution, 'false');
  verifierMotifRenseigne(execution);
  verifierAucuneReaction(execution);
});

test("commentaire-sur-pr.json — l'objet commenté est une pull request : refuse", () => {
  const execution = lancerGarde('commentaire-sur-pr', {
    fixture: 'commentaire-sur-pr.json',
    evenement: 'issue_comment',
  });

  verifierSocle(execution, 'false');
  verifierMotifRenseigne(execution);
  verifierAucuneReaction(execution);
});

test('commentaire-non-autorise.json — association NONE : refuse sans appeler le réseau', () => {
  const execution = lancerGarde('commentaire-non-autorise', {
    fixture: 'commentaire-non-autorise.json',
    evenement: 'issue_comment',
  });

  verifierSocle(execution, 'false');
  verifierMotifRenseigne(execution);
  // Étage 1 gratuit : le refus tombe avant tout appel à `gh`.
  assert.equal(
    execution.appels.length,
    0,
    `l'étage 1 doit refuser sans appel réseau ; appels observés : ` +
      `${JSON.stringify(execution.appels)}\n${execution.traces}`,
  );
});

test('commentaire-reedite.json — la mention était déjà là : refuse (anti-rejeu, R10)', () => {
  const execution = lancerGarde('commentaire-reedite', {
    fixture: 'commentaire-reedite.json',
    evenement: 'issue_comment',
  });

  verifierSocle(execution, 'false');
  verifierMotifRenseigne(execution);
  verifierAucuneReaction(execution);
});

// Cette fixture n'est JAMAIS lue : le refus tombe à l'étape 1, avant l'ouverture
// du fichier. Elle existe pour deux raisons — fournir un GITHUB_EVENT_PATH
// valide, et documenter le chemin exact qu'emprunte le smoke test du lot 5, où
// l'événement est un `push` ou un `pull_request`.
test('evenement-push.json — événement hors liste blanche : refuse', () => {
  const execution = lancerGarde('evenement-push', {
    fixture: 'evenement-push.json',
    evenement: 'push',
  });

  verifierSocle(execution, 'false');
  verifierMotifRenseigne(execution);
  assert.match(
    execution.sorties.motif,
    /push/,
    `le nom d'événement refusé doit être journalisé dans le motif : c'est le chemin ` +
      `du smoke test du lot 5\n${execution.traces}`,
  );
  assert.equal(execution.appels.length, 0, execution.traces);
});

test("issue-auteur-non-de-confiance.json — commentaire OWNER sur l'issue d'un tiers : poursuit en consigne restreinte", () => {
  const execution = lancerGarde('issue-auteur-non-de-confiance', {
    fixture: 'issue-auteur-non-de-confiance.json',
    evenement: 'issue_comment',
    env: {
      // Seul le commentateur est collaborateur ; l'auteur de l'issue reçoit un 404,
      // ce qui correspond à son association NONE.
      GH_STUB_LOGINS_AUTORISES: 'mainteneuse',
      EXIGER_AUTEUR_ISSUE_DE_CONFIANCE: 'true',
    },
  });
  const { sorties, appels, traces } = execution;

  // Le seul contrôle de bout en bout de l'atténuation de R6 côté garde : sans
  // cette sortie, le lot 3b enverrait le corps d'une issue rédigée par un
  // inconnu comme consigne.
  verifierSocle(execution, 'true', 'true');
  assert.equal(sorties.issue, '12', traces);
  assert.equal(sorties.branche, 'fix-issue-12', traces);

  // La permission des DEUX comptes a été demandée, dans cet ordre.
  assert.deepEqual(
    loginsControles(appels),
    ['mainteneuse', 'passante'],
    `l'étage 2 bis doit contrôler l'auteur de l'issue en plus de l'acteur\n${traces}`,
  );

  // On poursuit : la réaction est posée, sur l'endpoint du commentaire.
  const reactions = appelsReaction(appels);
  assert.equal(reactions.length, 1, traces);
  assert.equal(cheminReaction(reactions[0]), `repos/${DEPOT}/issues/comments/2005/reactions`, traces);
});

test('issue-mention-cachee.json — @dseek seulement dans un <!-- … --> : refuse (R6)', () => {
  const execution = lancerGarde('issue-mention-cachee', {
    fixture: 'issue-mention-cachee.json',
    evenement: 'issues',
  });

  // La mention qui déclenche doit être celle que le LECTEUR voit. Le texte
  // courant est donc cherché après nettoyerTexteTiers : sans ce nettoyage, un
  // `<!-- @dseek -->` invisible dans le rendu GitHub déclencherait l'action.
  verifierSocle(execution, 'false');
  verifierMotifRenseigne(execution);
  verifierAucuneReaction(execution);
});

test("commentaire-reedite-mention-cachee.json — l'ancienne version portait <!-- @dseek --> : refuse (R10)", () => {
  const execution = lancerGarde('commentaire-reedite-mention-cachee', {
    fixture: 'commentaire-reedite-mention-cachee.json',
    evenement: 'issue_comment',
  });

  // Règle INVERSE de la précédente, et c'est voulu : sur `changes.body.from` la
  // recherche se fait sur le texte BRUT. Si l'ancienne version portait la mention
  // cachée et la nouvelle la porte en clair, le contenu textuel n'a pas changé,
  // il n'y a rien à traiter. Nettoyer ici ferait passer cette édition pour une
  // demande nouvelle.
  verifierSocle(execution, 'false');
  verifierMotifRenseigne(execution);
  verifierAucuneReaction(execution);
});

// ═════════════════════════════════════════════════════════════════════════════
// B. Les garde-fous fail-closed
//
// Ils ne dépendent pas du payload mais de la RÉPONSE de l'API : aucune fixture
// du tableau ne peut les exercer. `commentaire-non-autorise.json` est refusée dès
// l'étage 1 et n'atteint jamais l'appel réseau — on pouvait donc retirer tout
// l'étage 2 de la garde sans faire rougir un seul des dix cas ci-dessus.
// ═════════════════════════════════════════════════════════════════════════════

// Une valeur par permission réellement renvoyée par l'API. Tester la seule
// « read » laisserait passer l'élargissement de la liste des permissions
// suffisantes à « triage », et « pull » est la valeur que renvoient les objets
// `permissions` du même endpoint.
for (const permission of ['read', 'triage', 'pull']) {
  test(`étage 2 — permission « ${permission} » malgré une association autorisée : refuse (l'association n'est pas une permission)`, () => {
    const execution = lancerGarde(`etage-2-permission-${permission}`, {
      fixture: 'commentaire-avec-dseek.json',
      evenement: 'issue_comment',
      env: { GH_STUB_PERMISSION: permission },
    });

    verifierSocle(execution, 'false');
    verifierMotifRenseigne(execution);
    assert.match(execution.sorties.motif, new RegExp(permission), execution.traces);
    verifierAucuneReaction(execution);
    // Le refus tombe à l'étage 2, donc avant l'étape 7.
    assert.equal(appelsPrList(execution.appels).length, 0, execution.traces);
  });
}

test('étage 2 — permission indéterminée (404) : refuse, fail-closed', () => {
  const execution = lancerGarde('etage-2-permission-404', {
    fixture: 'issue-avec-dseek.json',
    evenement: 'issues',
    env: { GH_STUB_SCENARIO: 'permission-refusee' },
  });

  verifierSocle(execution, 'false');
  verifierMotifRenseigne(execution);
  verifierAucuneReaction(execution);
});

test('étage 2 — `gh` en échec sur tous les appels : refuse, code 0 (un timeout ne vaut jamais « autorisé »)', () => {
  const execution = lancerGarde('etage-2-gh-en-echec', {
    fixture: 'issue-avec-dseek.json',
    evenement: 'issues',
    env: { GH_STUB_SCENARIO: 'echec' },
  });

  verifierSocle(execution, 'false');
  verifierMotifRenseigne(execution);
});

test("étape 7 — échec PARTIEL : la permission passe et seul `gh pr list` tombe ; l'état est indéterminé, donc refus", () => {
  const execution = lancerGarde('etape-7-echec-pr-list', {
    fixture: 'issue-avec-dseek.json',
    evenement: 'issues',
    env: { GH_STUB_SCENARIO: 'echec-pr-list' },
  });
  const { sorties, appels, traces } = execution;

  // Le scénario « echec » global ne peut pas atteindre cette branche : la
  // permission tomberait la première. D'où l'échec isolé.
  assert.deepEqual(
    loginsControles(appels),
    ['mainteneuse'],
    `la permission doit avoir répondu normalement, sinon ce cas n'exerce pas la ` +
      `branche visée\n${traces}`,
  );
  assert.equal(appelsPrList(appels).length, 1, `« gh pr list » doit avoir été tenté\n${traces}`);

  // « gh pr list » en échec ne veut PAS dire « une PR existe » : l'état est
  // inconnu. Rendre cet appel tolérant transformerait ce refus en poursuite.
  verifierSocle(execution, 'false');
  verifierMotifRenseigne(execution);
  assert.match(
    sorties.motif,
    /indéterminé/,
    `le motif doit dire que l'état est indéterminé, jamais qu'une PR a été ` +
      `trouvée\n${traces}`,
  );
  verifierAucuneReaction(execution);
});

test('étape 7 — une pull request est déjà ouverte sur la branche : refuse en la pointant', () => {
  const execution = lancerGarde('etape-7-pr-ouverte', {
    fixture: 'issue-avec-dseek.json',
    evenement: 'issues',
    env: { GH_STUB_SCENARIO: 'pr-ouverte', GH_STUB_NUMERO_PR: '314' },
  });

  verifierSocle(execution, 'false');
  verifierMotifRenseigne(execution);
  assert.match(
    execution.sorties.motif,
    /#314/,
    `le motif doit pointer la pull request ouverte\n${execution.traces}`,
  );
  // `issue` et `branche` restent renseignées sur ce refus tardif : le compte rendu
  // du lot 3c en a besoin pour désigner l'issue concernée.
  assert.equal(execution.sorties.issue, '42', execution.traces);
  assert.equal(execution.sorties.branche, 'fix-issue-42', execution.traces);
  verifierAucuneReaction(execution);
});

test('étape 7 — branche distante sans pull request ouverte : poursuit, elle sera reprise (R9)', () => {
  const execution = lancerGarde('etape-7-branche-distante', {
    fixture: 'issue-avec-dseek.json',
    evenement: 'issues',
    env: { GH_STUB_SCENARIO: 'branche-distante-existe' },
  });

  verifierSocle(execution, 'true');
  assert.equal(execution.sorties.branche, 'fix-issue-42', execution.traces);
});

test("étage 2 bis — l'auteur de l'issue a une permission « read » : consigne restreinte, pas refus", () => {
  const execution = lancerGarde('etage-2bis-auteur-read', {
    fixture: 'issue-auteur-non-de-confiance.json',
    evenement: 'issue_comment',
    env: {
      // Permission PAR LOGIN : l'auteur de l'issue est bien collaborateur, mais en
      // lecture seule. Sa permission n'est donc pas `null` — c'est le seul cas qui
      // distingue « permission insuffisante » de « permission indéterminée ».
      GH_STUB_PERMISSIONS_PAR_LOGIN: 'mainteneuse=admin,passante=read',
    },
  });

  verifierSocle(execution, 'true', 'true');
  assert.deepEqual(loginsControles(execution.appels), ['mainteneuse', 'passante'], execution.traces);
  assert.equal(execution.sorties.motif, '', execution.traces);
});

test('étage 2 bis — require-trusted-issue-author à « false » : pas de consigne restreinte', () => {
  const execution = lancerGarde('etage-2bis-desactive', {
    fixture: 'issue-auteur-non-de-confiance.json',
    evenement: 'issue_comment',
    env: {
      GH_STUB_PERMISSIONS_PAR_LOGIN: 'mainteneuse=admin,passante=read',
      EXIGER_AUTEUR_ISSUE_DE_CONFIANCE: 'false',
    },
  });

  verifierSocle(execution, 'true', 'false');
  // L'auteur de l'issue n'est même plus interrogé.
  assert.deepEqual(loginsControles(execution.appels), ['mainteneuse'], execution.traces);
});

test("étage 2 bis — l'acteur est lui-même l'auteur de l'issue : une seule interrogation", () => {
  const execution = lancerGarde('etage-2bis-meme-compte', {
    fixture: 'commentaire-avec-dseek.json',
    evenement: 'issue_comment',
  });

  verifierSocle(execution, 'true', 'false');
  assert.deepEqual(
    loginsControles(execution.appels),
    ['mainteneuse'],
    `le même compte ne doit pas être interrogé deux fois\n${execution.traces}`,
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// C. Validations d'entrée et forme des sorties
//
// Payloads volontairement malformés, écrits à la volée : ce ne sont pas des
// fixtures du plan.
// ═════════════════════════════════════════════════════════════════════════════

test('login hors norme : refuse sans construire de chemin d\'API', () => {
  const payload = ecrirePayload('login-hors-norme', {
    action: 'opened',
    issue: {
      number: 20,
      body: '@dseek corrige ce bogue.',
      // Deux segments : sans le contrôle de forme du login, le chemin d'API
      // construit devient `…/collaborators/mal/lory/permission`, que l'API peut
      // interpréter tout autrement.
      user: { login: 'mal/lory' },
      author_association: 'OWNER',
    },
  });

  const execution = lancerGarde('login-hors-norme', { payload, evenement: 'issues' });

  verifierSocle(execution, 'false');
  verifierMotifRenseigne(execution);
  assert.equal(
    execution.appels.length,
    0,
    `un login non conforme doit valoir refus AVANT tout appel à gh ; appels ` +
      `observés : ${JSON.stringify(execution.appels)}\n${execution.traces}`,
  );
});

test("numéro d'issue non entier : refuse (le contrôle sur le nom de branche ne suffit pas)", () => {
  const payload = ecrirePayload('numero-non-entier', {
    action: 'opened',
    issue: {
      // Une CHAÎNE, pas un entier. Choisie exprès pour que `fix-issue-42`
      // resterait conforme à /^fix-issue-\d+$/ : seul Number.isInteger attrape ce
      // payload.
      number: '42',
      body: '@dseek corrige ce bogue.',
      user: { login: 'mainteneuse' },
      author_association: 'OWNER',
    },
  });

  const execution = lancerGarde('numero-non-entier', { payload, evenement: 'issues' });

  verifierSocle(execution, 'false');
  verifierMotifRenseigne(execution);
  assert.equal(execution.sorties.branche, '', execution.traces);
  assert.equal(execution.sorties.issue, '', execution.traces);
  verifierAucuneReaction(execution);
});

test('un jeton recopié dans le motif est masqué', () => {
  const jeton = `ghp_${'A1b2C3d4E5'.repeat(4)}`; // 44 caractères, forme d'un jeton GitHub
  const payload = ecrirePayload('motif-avec-jeton', {
    action: 'created',
    issue: { number: 21, user: { login: 'mainteneuse' } },
    comment: {
      id: 2101,
      body: '@dseek corrige ce bogue.',
      // Le motif de l'étage 1 recopie le login. Les logs d'un job sont publics
      // sur un dépôt public, et `motif` finit dans le compte rendu de PR.
      user: { login: jeton },
      author_association: 'NONE',
    },
  });

  const execution = lancerGarde('motif-avec-jeton', { payload, evenement: 'issue_comment' });

  verifierSocle(execution, 'false');
  verifierMotifRenseigne(execution);
  assert.ok(
    !execution.sorties.motif.includes(jeton),
    `le jeton ne doit pas apparaître en clair dans « motif »\n${execution.sorties.motif}`,
  );
  assert.match(execution.sorties.motif, /SECRET RETIRÉ/, execution.traces);
});

test('un motif contenant le délimiteur ne peut pas injecter de sortie', () => {
  // Le vecteur : refermer le bloc à délimiteur par surprise, puis écrire une
  // seconde paire `poursuivre=true` que le runner lira en dernier. Le contrôle de
  // l'ensemble des clés, dans le socle, verrouille la variante qui ajoute une
  // sortie inconnue.
  const payload = ecrirePayload('motif-avec-delimiteur', {
    action: 'created',
    issue: { number: 22, user: { login: 'mainteneuse' } },
    comment: {
      id: 2201,
      body: '@dseek corrige ce bogue.',
      user: { login: 'passante\nEOF_MOTIF\npoursuivre=true\nintrus=1' },
      author_association: 'NONE',
    },
  });

  const execution = lancerGarde('motif-avec-delimiteur', { payload, evenement: 'issue_comment' });

  verifierSocle(execution, 'false');
  verifierMotifRenseigne(execution);
  assert.ok(
    !execution.sorties.motif.includes('EOF_MOTIF'),
    `le délimiteur doit être neutralisé dans le motif\n${execution.sorties.motif}`,
  );
  assert.match(execution.sorties.motif, /fin-de-motif/, execution.traces);
});

// ─── L'écriture des sorties peut elle-même échouer ───────────────────────────
//
// Ces deux cas ne peuvent pas passer par le socle : il n'y a aucun GITHUB_OUTPUT
// à relire. Ils ne contrôlent qu'une chose, la seule qui compte ici, et c'est la
// règle centrale du lot : le code de sortie reste 0.

test('GITHUB_OUTPUT impossible à écrire : annote le job, mais sort en 0', () => {
  // Un GITHUB_OUTPUT pointant un répertoire fait lever appendFileSync (EISDIR).
  // Autres causes réelles : parent inexistant, droits, step précédent qui a
  // bricolé le fichier. Laisser filer l'exception ferait sortir la garde en code
  // 1 — donc rougir le job sur un commentaire anodin, avec une cause affichée qui
  // n'a rien à voir avec la décision. C'est le fail-closed PAR ACCIDENT que ce
  // lot condamne.
  const execution = lancerGarde('sorties-en-repertoire', {
    fixture: 'issue-sans-dseek.json',
    evenement: 'issues',
    sorties: 'repertoire',
  });

  assert.equal(
    execution.resultat.status,
    0,
    `une écriture de sortie impossible ne doit pas faire échouer le step\n${execution.traces}`,
  );
  assert.match(
    execution.resultat.stdout,
    /::error::/,
    `l'incident doit être annoté sur le job : sans trace, une sortie perdue est ` +
      `indiagnosticable\n${execution.traces}`,
  );
  // La décision reste lisible dans les logs, faute de mieux.
  assert.match(execution.resultat.stdout, /poursuivre=false/, execution.traces);
});

test('GITHUB_OUTPUT absente (essai à la main hors runner) : sort en 0 et affiche la décision', () => {
  const execution = lancerGarde('sorties-absentes', {
    fixture: 'issue-avec-dseek.json',
    evenement: 'issues',
    sorties: 'absente',
  });

  assert.equal(execution.resultat.status, 0, execution.traces);
  assert.match(execution.resultat.stdout, /poursuivre=true/, execution.traces);
});
