'use strict';

// Harnais de test de `scripts/rendre-compte.js` — lot 4.
//
// Node pur, bibliothèque standard uniquement (`node:test`, `node:assert/strict`),
// CommonJS, aucune dépendance npm, aucun réseau, aucune clé d'API. Lancement :
//
//   node test/compte-rendu.test.js
//
// Le script est lancé en SOUS-PROCESSUS, avec un tableau d'arguments et jamais
// `shell: true`, exactement comme le runner le fait, et avec `GH_CLI` pointé sur
// `__fixtures__/gh-stub.sh`. C'est le seul moyen d'observer un code de sortie réel,
// et le seul moyen de compter les appels à `gh` — ce que ce script fait ou ne fait
// PAS auprès de l'API est ici la moitié de ce qu'il y a à vérifier.
//
// ─── Ce que le socle commun contrôle sur CHAQUE cas ──────────────────────────
//
//   le code de sortie, qui vaut 0 PARTOUT : refus d'entrée, échec de publication,
//   binaire `gh` absent. Le contrat l'exige, et c'est ce qui empêche ce step — le
//   dernier du job, sous `if: always()` — de faire rougir un job dont la validation
//   est passée, ou de masquer le verdict déjà rendu par `resolve.js`.
//
// ─── Les six familles de cas ─────────────────────────────────────────────────
//
//   A. les refus d'entrée, fail-closed : `::error::` qui NOMME l'entrée fautive, et
//      ZÉRO appel `gh` — on ne poste pas sur une cible qu'on n'a pas su valider ;
//   B. les chemins qui ne publient pas (`no-publish`, statut « success », jeton
//      absent) : zéro appel `gh`, et le corps quand même dans les logs ;
//   C. l'idempotence et la PORTÉE du run — le cœur du lot. Chaque cas contrôle la
//      DÉCISION et le NOMBRE d'appels de publication ;
//   D. la cible : pull request si elle existe, issue sinon, et `--repo` sur CHAQUE
//      appel — vérifié sur l'argv relevé par le stub, pas sur la sortie du script ;
//   E. les dégradations : lecture impossible, publication impossible, `gh` absent ;
//   F. le texte publié, et l'ACCORD de forme du marqueur entre `rendre-compte.js`
//      et `resolve.js` — seul contrôle qui empêche les deux fichiers de diverger
//      plus tard, et le contrat l'exige explicitement.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RACINE = path.resolve(__dirname, '..');
const RENDRE_COMPTE = path.join(RACINE, 'scripts', 'rendre-compte.js');
const FIXTURES = path.join(RACINE, '__fixtures__');

// Le stub versionné du lot 1, jamais `/bin/true` : avec un stdout vide,
// `JSON.parse('')` lève dans `lib/gh.js`. Chemin absolu : le stub doit être trouvé
// quel que soit le répertoire depuis lequel on lance le test.
const STUB_GH = path.join(FIXTURES, 'gh-stub.sh');

const DEPOT = 'proprietaire/depot';
const NUMERO_ISSUE = '7';
const BRANCHE = 'fix-issue-7';
// Numéro de la pull request rendue par le stub quand `GH_STUB_PR_LIST=pr`.
const NUMERO_PR = '9';

// Formes du marqueur, recopiées de `plan/contrat.md` et de rien d'autre. Les
// comparer à des littéraux — et non à ce que rend le code — est ce qui rend le
// contrôle d'accord utile : deux fichiers mutés de la même façon resteraient
// d'accord entre eux, et faux tous les deux.
const MARQUEUR_NU = '<!-- deepseek-resolve:compte-rendu -->';
const marqueurPorte = (portee) => `<!-- deepseek-resolve:compte-rendu run=${portee} -->`;

// Tout ce que le test écrit vit sous le répertoire temporaire du système, jamais
// dans le dépôt : un journal de stub oublié dans `__fixtures__/` finirait committé.
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'compte-rendu-test-'));

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

/**
 * Les corps réellement passés à `gh --body-file`, recopiés par le stub avant que
 * `avecFichierCorps` ne supprime son temporaire. Sans cette copie, rien ne peut
 * vérifier CE QUI aurait été publié.
 * @param {string} repertoire
 * @returns {string[]}
 */
function lireCorpsPublies(repertoire) {
  if (!fs.existsSync(repertoire)) return [];
  return fs
    .readdirSync(repertoire)
    .sort()
    .map((nom) => fs.readFileSync(path.join(repertoire, nom), 'utf8'));
}

/** Les appels de PUBLICATION : `pr comment` ou `issue comment`. */
function appelsPublication(appels) {
  return appels.filter((args) => args[1] === 'comment');
}

/** Les appels de LECTURE des commentaires : `pr view` ou `issue view`. */
function appelsLecture(appels) {
  return appels.filter((args) => args[1] === 'view');
}

/** Les appels `pr list`, qui résolvent la pull request de la branche. */
function appelsPrList(appels) {
  return appels.filter((args) => args[0] === 'pr' && args[1] === 'list');
}

/**
 * Les lignes d'annotation d'un type donné, relevées par leur PRÉFIXE.
 *
 * C'est le fait observable : le runner reconnaît une annotation à `::warning::` ou
 * `::error::`, pas à sa phrase. Tout contrôle de dégradation s'appuie là-dessus.
 *
 * Mesuré sur ce fichier même : un test qui NIAIT un libellé (« … n'a pas pu être
 * relu ») est resté vert après que le défaut visé a été corrigé, parce que le
 * nouveau message était rédigé autrement. Une assertion négative sur une phrase ne
 * contrôle rien — elle valide n'importe quel comportement dès que la phrase change.
 *
 * @param {string} stdout
 * @param {'warning'|'error'|'notice'} type
 * @returns {string[]}
 */
function annotations(stdout, type) {
  return stdout.split('\n').filter((ligne) => ligne.startsWith(`::${type}::`));
}

/** Un appel, rendu lisible dans un message d'échec. */
function libelle(args) {
  return args.join(' ');
}

// ─── Lancement du script ─────────────────────────────────────────────────────

/**
 * Lance `scripts/rendre-compte.js` en sous-processus.
 *
 * L'environnement est construit DE ZÉRO : le script ne doit rien devoir à celui de
 * la machine de développement, et surtout pas à un `GITHUB_RUN_ID` qui traînerait —
 * la portée du run est précisément ce que la moitié des cas fait varier.
 *
 * Journal de stub, répertoire de copie des corps et fichiers temporaires sont
 * PROPRES À CHAQUE CAS : deux cas qui partagent un journal mélangent leurs appels,
 * et un test qui compte les appels du voisin ne prouve rien.
 *
 * @param {string} cas identifiant du cas, sert à nommer les fichiers temporaires
 * @param {{ env?: Record<string, string|null> }} [options]
 *   `env` : surcharges. La valeur `null` SUPPRIME la variable — c'est ainsi qu'on
 *   exerce le repli sans portée de run, et une variable absente n'est pas la même
 *   chose qu'une variable vide.
 */
function lancer(cas, { env = {} } = {}) {
  const journal = path.join(TEMP, `${cas}.journal-gh`);
  const copieCorps = path.join(TEMP, `${cas}.corps`);

  const environnement = {
    PATH: process.env.PATH,
    HOME: process.env.HOME || TEMP,
    // Les variables du contrat, table « rendre-compte.js ».
    GITHUB_REPOSITORY: DEPOT,
    NUMERO_ISSUE,
    BRANCHE,
    // « failure » par défaut : c'est le seul statut où ce script a du travail, donc
    // le seul défaut utile. « success » est un cas à part, exercé pour lui-même.
    STATUT_JOB: 'failure',
    GH_TOKEN: 'jeton-de-test',
    // Trappe de test du contrat : sans elle, ce fichier n'existerait pas.
    GH_CLI: STUB_GH,
    GH_STUB_JOURNAL: journal,
    GH_STUB_COPIE_CORPS: copieCorps,
    ...env,
  };

  for (const [cle, valeur] of Object.entries(environnement)) {
    if (valeur === null || valeur === undefined) delete environnement[cle];
  }

  const resultat = spawnSync(process.execPath, [RENDRE_COMPTE], {
    cwd: RACINE,
    encoding: 'utf8',
    // Jamais `shell: true` : un tableau d'arguments ferme l'injection de commande.
    shell: false,
    env: environnement,
  });

  assert.equal(
    resultat.error,
    undefined,
    `lancement de rendre-compte.js impossible : ${resultat.error && resultat.error.message}`,
  );

  const appels = lireJournal(journal);

  return {
    resultat,
    stdout: resultat.stdout,
    stderr: resultat.stderr,
    appels,
    corps: lireCorpsPublies(copieCorps),
    // Utile quand une assertion tombe : sans les traces, un test rouge sur un
    // sous-processus ne dit rien.
    traces:
      `--- stdout ---\n${resultat.stdout}\n--- stderr ---\n${resultat.stderr}\n` +
      `--- appels gh (${appels.length}) ---\n${appels.map(libelle).join('\n')}`,
  };
}

// ─── Socle commun ────────────────────────────────────────────────────────────

/**
 * Le seul contrôle qui s'applique à TOUS les cas, et le plus important : ce script
 * sort en 0, quoi qu'il arrive.
 */
function verifierCodeZero(execution) {
  assert.equal(
    execution.resultat.status,
    0,
    'rendre-compte.js doit sortir en code 0 sur TOUS les chemins — refus d\'entrée et ' +
      `échec de publication compris ; obtenu ${execution.resultat.status}\n${execution.traces}`,
  );
}

/**
 * Aucun appel à `gh`. Compté dans le journal écrit par le stub, pas déduit de la
 * sortie du script : c'est l'argv réel qui fait foi.
 */
function verifierAucunAppelGh(execution, pourquoi) {
  assert.deepEqual(
    execution.appels.map(libelle),
    [],
    `aucun appel à gh attendu (${pourquoi})\n${execution.traces}`,
  );
}

/** Un refus muet est indébogable : le motif doit nommer l'entrée fautive. */
function verifierErreurNommant(execution, nomEntree) {
  const lignes = annotations(execution.stdout, 'error');
  assert.equal(
    lignes.length,
    1,
    `un seul ::error:: attendu sur un refus d'entrée\n${execution.traces}`,
  );
  assert.ok(
    lignes[0].includes(nomEntree),
    `le ::error:: doit NOMMER l'entrée fautive « ${nomEntree} » : c'est un câblage env: ` +
      `incomplet dans action.yml, et le lecteur des logs doit savoir quelle ligne ajouter` +
      `\n${execution.traces}`,
  );
}

/**
 * La décision d'idempotence, contrôlée sur des FAITS et sur rien d'autre : le nombre
 * d'appels `gh … comment` relevés dans le journal du stub, le nombre de corps
 * réellement passés à `--body-file`, et le nombre de lectures.
 *
 * Aucune assertion sur une phrase du journal, et surtout aucune assertion NÉGATIVE
 * sur une phrase. Les deux questions à trancher sont « un commentaire est-il
 * parti ? » et « le script avait-il de quoi décider ? » : les deux sont observables
 * sur l'argv relevé et sur le fichier de corps. Un libellé se réécrit sans que le
 * comportement change ; un appel `gh` non.
 *
 * @param {object} execution
 * @param {boolean} publieAttendu
 */
function verifierDecision(execution, publieAttendu) {
  const publications = appelsPublication(execution.appels);
  if (publieAttendu) {
    assert.equal(
      publications.length,
      1,
      `un seul commentaire de secours attendu\n${execution.traces}`,
    );
    // Un appel de publication sans corps préparé posterait un commentaire vide.
    assert.equal(
      execution.corps.length,
      1,
      `un corps doit avoir été préparé et passé à --body-file\n${execution.traces}`,
    );
  } else {
    assert.equal(
      publications.length,
      0,
      `aucun commentaire ne doit partir : un compte rendu de CE run est déjà présent` +
        `\n${execution.traces}`,
    );
    assert.deepEqual(
      execution.corps,
      [],
      `aucun corps n'a à être préparé quand il n'y a rien à publier\n${execution.traces}`,
    );
    // Le silence doit être une CONCLUSION, pas un abandon en amont : la lecture des
    // commentaires a bien eu lieu. C'est ce fait qui distingue « il a lu, puis
    // décidé » de « il est mort avant de lire » — l'absence d'une phrase dans le
    // journal ne les distinguerait pas.
    assert.equal(
      appelsLecture(execution.appels).length,
      1,
      `la décision de ne rien republier doit suivre une lecture des commentaires` +
        `\n${execution.traces}`,
    );
  }
}

/**
 * `--repo <GITHUB_REPOSITORY>` sur CHAQUE appel. Sans lui, `gh` résout le dépôt par
 * le remote du répertoire courant : ça marche par effet de bord en production, et ça
 * interroge le mauvais dépôt en test.
 */
function verifierRepoPartout(execution) {
  assert.ok(execution.appels.length > 0, `aucun appel à contrôler\n${execution.traces}`);
  for (const args of execution.appels) {
    const position = args.indexOf('--repo');
    assert.ok(
      position !== -1,
      `l'appel « ${libelle(args)} » ne porte pas --repo\n${execution.traces}`,
    );
    assert.equal(
      args[position + 1],
      DEPOT,
      `l'appel « ${libelle(args)} » doit porter --repo ${DEPOT}\n${execution.traces}`,
    );
  }
}

/** Occurrences d'une sous-chaîne, marqueurs compris. */
function compter(texte, aiguille) {
  return texte.split(aiguille).length - 1;
}

// ═════════════════════════════════════════════════════════════════════════════
// A. Refus d'entrée — fail-closed
//
// On ne poste pas sur une cible qu'on n'a pas su valider. Ces valeurs ne viennent
// pas d'un utilisateur mais d'un `env:` incomplet dans `action.yml` — l'oubli le
// plus probable de tout le plan, puisqu'une composite action n'expose PAS ses
// inputs en `INPUT_*` aux sous-processus.
// ═════════════════════════════════════════════════════════════════════════════

test("NUMERO_ISSUE qui n'est pas un entier positif : refus nommé, zéro appel gh, code 0", () => {
  for (const valeur of ['', 'abc', '7.5', '0', '-3', '7 8', 'sept']) {
    const execution = lancer(`numero-${encodeURIComponent(valeur) || 'vide'}`, {
      env: { NUMERO_ISSUE: valeur },
    });
    verifierCodeZero(execution);
    verifierErreurNommant(execution, 'NUMERO_ISSUE');
    verifierAucunAppelGh(execution, `NUMERO_ISSUE=${JSON.stringify(valeur)} est invalide`);
  }
});

test('NUMERO_ISSUE non DÉCIMAL : refusé, zéro appel gh, code 0', () => {
  // `Number` accepte l'hexadécimal, l'exponentielle, le signe et le point : `0x10`
  // vaut 16, `1e3` vaut 1000, et les deux passent `Number.isInteger`. Le message du
  // script promet « un entier décimal positif » — ces cas sont là pour que la
  // promesse soit vraie, et pour que `/^\d+$/` ne puisse pas repartir.
  for (const valeur of ['0x10', '1e3', '+12', '12.0', '1_2', '0b1100', '٧']) {
    const execution = lancer(`numero-non-decimal-${encodeURIComponent(valeur)}`, {
      env: { NUMERO_ISSUE: valeur },
    });
    verifierCodeZero(execution);
    verifierErreurNommant(execution, 'NUMERO_ISSUE');
    verifierAucunAppelGh(execution, `NUMERO_ISSUE=${JSON.stringify(valeur)} n'est pas décimal`);
  }
});

test("NUMERO_ISSUE hors de l'entier sûr : refusé, zéro appel gh, code 0", () => {
  // `/^\d+$/` laisse passer n'importe quelle longueur de chiffres, et au-delà de 2^53
  // `Number` arrondit : mesuré, `99999999999999999999` visait
  // `issue comment 100000000000000000000` — un numéro qui n'est pas celui reçu. D'où
  // `Number.isSafeInteger` et non `Number.isInteger`.
  //
  // `9007199254740992` est 2^53 : le premier entier non sûr, donc le cas limite exact.
  for (const valeur of ['99999999999999999999', '9007199254740992', '1'.repeat(30)]) {
    const execution = lancer(`numero-hors-borne-${valeur.length}-${valeur[0]}`, {
      env: { NUMERO_ISSUE: valeur },
    });
    verifierCodeZero(execution);
    verifierErreurNommant(execution, 'NUMERO_ISSUE');
    verifierAucunAppelGh(
      execution,
      `NUMERO_ISSUE=${JSON.stringify(valeur)} n'est pas un entier sûr`,
    );
  }
});

test('NUMERO_ISSUE décimal : accepté, et le compte rendu part sur la cible', () => {
  // Contrepartie du cas ci-dessus : un contrôle d'entrée qui refuse tout serait vert
  // sur toute la famille A et le script ne publierait plus jamais rien.
  //
  // `012` est accepté et vaut 12 : `/^\d+$/` le laisse passer, `Number` le lit en
  // décimal. Voulu. « 12 » entouré d'espaces est accepté AUSSI, parce que `lireEnv`
  // trim avant de valider — un `env:` de workflow indenté ne doit pas faire échouer
  // le dernier step du job.
  // `9007199254740991` est 2^53-1, le plus grand entier sûr : il doit passer. Sans ce
  // cas, resserrer la borne d'un cran resterait vert et un dépôt à très gros numéros
  // d'issue perdrait son compte rendu.
  for (const valeur of ['12', '012', ' 12 ', '7', '9007199254740991']) {
    const execution = lancer(`numero-decimal-${encodeURIComponent(valeur)}`, {
      env: {
        NUMERO_ISSUE: valeur,
        BRANCHE: 'fix-issue-12',
        GH_STUB_PR_LIST: 'pr',
        GH_STUB_NUMERO_PR: NUMERO_PR,
      },
    });
    verifierCodeZero(execution);
    assert.deepEqual(
      annotations(execution.stdout, 'error'),
      [],
      `NUMERO_ISSUE=${JSON.stringify(valeur)} est un entier décimal : aucun refus ` +
        `attendu\n${execution.traces}`,
    );
    verifierDecision(execution, true);
    verifierRepoPartout(execution);
  }
});

test('BRANCHE hors de /^fix-issue-\\d+$/ : refus nommé, zéro appel gh, code 0', () => {
  // « --force » est là pour lui-même : cette valeur part en ARGUMENT de `gh`, et une
  // chaîne commençant par un tiret y serait lue comme une option.
  for (const valeur of [
    '',
    '--force',
    'main',
    'fix-issue-',
    'fix-issue-7x',
    'fix-issue-7 --force',
    'Fix-Issue-7',
    '../fix-issue-7',
  ]) {
    const execution = lancer(`branche-${encodeURIComponent(valeur) || 'vide'}`, {
      env: { BRANCHE: valeur },
    });
    verifierCodeZero(execution);
    verifierErreurNommant(execution, 'BRANCHE');
    verifierAucunAppelGh(execution, `BRANCHE=${JSON.stringify(valeur)} est invalide`);
  }
});

test('GITHUB_REPOSITORY mal formé : refus nommé, zéro appel gh, code 0', () => {
  // Cette valeur part en argument de `--repo` : une forme non contrôlée y désignerait
  // un AUTRE dépôt, et le compte rendu de secours irait le commenter.
  for (const valeur of ['', 'depot', 'a/b/c', '--repo', 'pro prietaire/depot', 'a/', '/b']) {
    const execution = lancer(`depot-${encodeURIComponent(valeur) || 'vide'}`, {
      env: { GITHUB_REPOSITORY: valeur },
    });
    verifierCodeZero(execution);
    verifierErreurNommant(execution, 'GITHUB_REPOSITORY');
    verifierAucunAppelGh(execution, `GITHUB_REPOSITORY=${JSON.stringify(valeur)} est invalide`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// B. Les chemins qui ne publient pas
// ═════════════════════════════════════════════════════════════════════════════

test('SANS_PUBLICATION=true : le corps part dans le journal du job et nulle part ailleurs', () => {
  const execution = lancer('sans-publication', { env: { SANS_PUBLICATION: 'true' } });

  verifierCodeZero(execution);
  verifierAucunAppelGh(execution, 'no-publish interdit toute écriture');
  assert.ok(
    execution.stdout.includes('no-publish'),
    `la décision doit être journalisée\n${execution.traces}`,
  );
  // Le corps entier, marqueur compris : sous `no-publish` les logs du job sont le
  // seul endroit où l'utilisateur puisse le lire.
  assert.ok(
    execution.stdout.includes(MARQUEUR_NU),
    `le corps complet doit être journalisé sous no-publish\n${execution.traces}`,
  );
  assert.ok(
    execution.stdout.includes(`\`${BRANCHE}\``),
    `le corps doit nommer la branche qui porte le travail\n${execution.traces}`,
  );
});

test('SANS_PUBLICATION=true et statut « success » : la réserve précède le corps', () => {
  // « statut inattendu (success) » suivi d'un démenti se lit à l'envers : le lecteur
  // des logs croit le premier des deux messages. L'ordre est donc une exigence, pas
  // une préférence de rédaction.
  const execution = lancer('sans-publication-success', {
    env: { SANS_PUBLICATION: 'true', STATUT_JOB: 'success' },
  });

  verifierCodeZero(execution);
  verifierAucunAppelGh(execution, 'no-publish interdit toute écriture');

  // Ancré sur des entités, pas sur les phrases : le nom de l'input (`no-publish`), la
  // valeur du statut (`success`) et le marqueur du contrat. La réserve est journalisée
  // sur la MÊME ligne que l'annonce, le corps commence à la ligne suivante — donc
  // l'ordre se lit sur la position, sans citer une seule formulation.
  const lignes = execution.stdout.split('\n');
  assert.ok(
    lignes[0].includes('no-publish'),
    `la première ligne doit annoncer la décision\n${execution.traces}`,
  );
  assert.ok(
    lignes[0].includes('success'),
    `la réserve doit nommer le statut du job sur la ligne d'annonce, AVANT le corps : ` +
      `« statut inattendu (success) » suivi d'un démenti se lit à l'envers, et le ` +
      `lecteur croit le premier des deux\n${execution.traces}`,
  );
  const positionMarqueur = execution.stdout.indexOf(MARQUEUR_NU);
  assert.ok(
    positionMarqueur > lignes[0].length,
    `le corps, reconnu à son marqueur, doit venir après la ligne d'annonce` +
      `\n${execution.traces}`,
  );
});

test('STATUT_JOB=success : la décision de se taire est journalisée, zéro appel gh', () => {
  const execution = lancer('statut-success', { env: { STATUT_JOB: 'success' } });

  verifierCodeZero(execution);
  verifierAucunAppelGh(
    execution,
    'la boucle a publié son propre compte rendu : rien à lire, rien à écrire',
  );
  assert.ok(
    execution.stdout.includes('success'),
    `sans cette ligne, un lecteur de logs ne comprend pas le silence de ce step` +
      `\n${execution.traces}`,
  );
});

test('GH_TOKEN vide : le corps est journalisé AVANT le ::error::, zéro appel gh, code 0', () => {
  const execution = lancer('sans-jeton', { env: { GH_TOKEN: '' } });

  verifierCodeZero(execution);
  verifierAucunAppelGh(execution, 'sans jeton, aucun appel ne peut aboutir');

  const positionCorps = execution.stdout.indexOf(MARQUEUR_NU);
  const positionErreur = execution.stdout.indexOf('::error::');
  assert.ok(
    positionCorps !== -1,
    `le corps doit être journalisé même sans jeton : c'est le dernier message que ` +
      `l'utilisateur puisse recevoir\n${execution.traces}`,
  );
  assert.ok(positionErreur !== -1, `l'absence de jeton doit être signalée\n${execution.traces}`);
  assert.ok(
    positionCorps < positionErreur,
    `le corps doit précéder le ::error:: : il ne doit dépendre ni d'un jeton ni du ` +
      `réseau, et un lecteur qui s'arrête à la première erreur doit l'avoir déjà lu` +
      `\n${execution.traces}`,
  );
  assert.ok(
    execution.stdout.includes('GH_TOKEN'),
    `le ::error:: doit nommer GH_TOKEN\n${execution.traces}`,
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// C. Idempotence et portée du run — le cœur du lot
//
// R9 fait servir le même couple issue / branche à PLUSIEURS runs : un second
// « @dseek » reprend `fix-issue-<n>` et la même pull request, où le compte rendu du
// run précédent est encore, marqueur compris. Sans portée, ce script s'y reconnaît,
// se croit déjà passé et ne publie rien — sur la panne même que le step
// `if: always()` existe pour couvrir.
//
// Chaque cas ci-dessous fixe la PORTÉE COURANTE (`GITHUB_RUN_ID` /
// `GITHUB_RUN_ATTEMPT`) et la portée du marqueur DÉJÀ PRÉSENT
// (`GH_STUB_PORTEE_MARQUEUR`), puis contrôle la décision et le nombre d'appels de
// publication.
// ═════════════════════════════════════════════════════════════════════════════

/** Environnement commun aux cas d'idempotence : une pull request existe. */
function envIdempotence(surcharges) {
  return {
    GH_STUB_PR_LIST: 'pr',
    GH_STUB_NUMERO_PR: NUMERO_PR,
    ...surcharges,
  };
}

test('même portée des deux côtés : ne republie rien', () => {
  const execution = lancer('idem-meme-portee', {
    env: envIdempotence({
      GITHUB_RUN_ID: '222',
      GITHUB_RUN_ATTEMPT: '1',
      GH_STUB_COMMENTAIRES: 'tiers,marqueur-portee',
      GH_STUB_PORTEE_MARQUEUR: '222-1',
    }),
  });

  verifierCodeZero(execution);
  verifierDecision(execution, false);
  // Les lectures ont bien eu lieu : « rien à republier » doit être une CONCLUSION,
  // pas un abandon silencieux en amont.
  assert.equal(appelsPrList(execution.appels).length, 1, execution.traces);
  assert.equal(appelsLecture(execution.appels).length, 1, execution.traces);
});

test("portée courante 222-1 face au compte rendu d'un run précédent (111-1) : publie", () => {
  const execution = lancer('idem-run-precedent', {
    env: envIdempotence({
      GITHUB_RUN_ID: '222',
      GITHUB_RUN_ATTEMPT: '1',
      GH_STUB_COMMENTAIRES: 'marqueur-portee',
      GH_STUB_PORTEE_MARQUEUR: '111-1',
    }),
  });

  verifierCodeZero(execution);
  verifierDecision(execution, true);
  // Et le compte rendu publié porte la portée du run COURANT, sinon le run suivant
  // le prendrait pour le sien.
  assert.ok(
    execution.corps[0].endsWith(marqueurPorte('222-1')),
    `le compte rendu publié doit porter la portée du run courant\n${execution.traces}`,
  );
});

test('portée courante 222-1 face à un marqueur NU laissé par un ancien run : publie', () => {
  // Le trou mesuré et tranché dans le contrat : avant la portée, ce cas rendait
  // « rien à republier » et l'utilisateur du run 2 ne recevait RIEN alors que le job
  // venait de mourir.
  const execution = lancer('idem-marqueur-nu', {
    env: envIdempotence({
      GITHUB_RUN_ID: '222',
      GITHUB_RUN_ATTEMPT: '1',
      GH_STUB_COMMENTAIRES: 'marqueur-nu',
    }),
  });

  verifierCodeZero(execution);
  verifierDecision(execution, true);
});

test('GITHUB_RUN_ATTEMPT incrémentée (222-2 face à 222-1) : publie, c\'est un nouveau verdict', () => {
  // « Re-run failed jobs » : la tentative s'incrémente, la portée change, le compte
  // rendu de la nouvelle tentative part. Ce n'est pas un doublon.
  const execution = lancer('idem-nouvelle-tentative', {
    env: envIdempotence({
      GITHUB_RUN_ID: '222',
      GITHUB_RUN_ATTEMPT: '2',
      GH_STUB_COMMENTAIRES: 'marqueur-portee',
      GH_STUB_PORTEE_MARQUEUR: '222-1',
    }),
  });

  verifierCodeZero(execution);
  verifierDecision(execution, true);
  assert.ok(
    execution.corps[0].endsWith(marqueurPorte('222-2')),
    `le compte rendu de la seconde tentative doit porter « 222-2 »\n${execution.traces}`,
  );
});

test('sans GITHUB_RUN_ID (repli) face au marqueur nu : ne republie rien', () => {
  // Régime de repli : hors Actions, rien ne permettrait de distinguer les runs, donc
  // n'importe quel compte rendu compte. C'est le seul régime local et de test.
  const execution = lancer('idem-repli-nu', {
    env: envIdempotence({
      GITHUB_RUN_ID: null,
      GITHUB_RUN_ATTEMPT: null,
      GH_STUB_COMMENTAIRES: 'marqueur-nu',
    }),
  });

  verifierCodeZero(execution);
  verifierDecision(execution, false);
});

test('sans GITHUB_RUN_ID face à un marqueur PORTÉ : ne republie rien non plus', () => {
  const execution = lancer('idem-repli-porte', {
    env: envIdempotence({
      GITHUB_RUN_ID: null,
      GITHUB_RUN_ATTEMPT: null,
      GH_STUB_COMMENTAIRES: 'marqueur-portee',
      GH_STUB_PORTEE_MARQUEUR: '111-1',
    }),
  });

  verifierCodeZero(execution);
  verifierDecision(execution, false);
});

test('GITHUB_RUN_ATTEMPT seule, sans GITHUB_RUN_ID : repli, donc le marqueur nu suffit', () => {
  // La portée exige les DEUX valeurs : une seule ne distingue rien.
  const execution = lancer('idem-tentative-seule', {
    env: envIdempotence({
      GITHUB_RUN_ID: null,
      GITHUB_RUN_ATTEMPT: '3',
      GH_STUB_COMMENTAIRES: 'marqueur-nu',
    }),
  });

  verifierCodeZero(execution);
  verifierDecision(execution, false);
});

test('GITHUB_RUN_ID non numérique : repli sur le marqueur nu', () => {
  for (const identifiant of ['abc', '22.2', '2 2', '-1']) {
    const execution = lancer(`idem-run-id-${encodeURIComponent(identifiant)}`, {
      env: envIdempotence({
        GITHUB_RUN_ID: identifiant,
        GITHUB_RUN_ATTEMPT: '1',
        GH_STUB_COMMENTAIRES: 'marqueur-nu',
      }),
    });

    verifierCodeZero(execution);
    verifierDecision(execution, false);
  }
});

test('GITHUB_RUN_ID portant « --> » : repli, et le marqueur écrit ne referme rien en avance', () => {
  // Une portée part dans un commentaire HTML. Une valeur portant « --> » le
  // refermerait en avance, et la suite du compte rendu — le marqueur compris —
  // deviendrait visible dans le rendu GitHub.
  const execution = lancer('idem-run-id-hostile', {
    env: envIdempotence({
      GITHUB_RUN_ID: '222 --> visible',
      GITHUB_RUN_ATTEMPT: '1',
      GH_STUB_COMMENTAIRES: 'aucun',
    }),
  });

  verifierCodeZero(execution);
  verifierDecision(execution, true);

  const corps = execution.corps[0];
  assert.ok(
    corps.endsWith(MARQUEUR_NU),
    `une portée invalide doit être traitée comme une absence, donc rendre la forme NUE` +
      `\n${execution.traces}`,
  );
  assert.equal(
    compter(corps, '-->'),
    1,
    `un seul « --> » dans le corps : celui qui ferme le marqueur\n${execution.traces}`,
  );
  assert.ok(
    !corps.includes('visible'),
    `la valeur hostile ne doit pas atteindre le corps publié\n${execution.traces}`,
  );
});

test("un commentaire tiers sans marqueur ne fait pas taire le filet de sécurité", () => {
  const execution = lancer('idem-tiers-seul', {
    env: envIdempotence({
      GITHUB_RUN_ID: '222',
      GITHUB_RUN_ATTEMPT: '1',
      GH_STUB_COMMENTAIRES: 'tiers,tiers',
    }),
  });

  verifierCodeZero(execution);
  verifierDecision(execution, true);
});

test('LIMITE ASSUMÉE : un commentaire tiers qui imite la portée courante fait taire le filet', () => {
  // Comportement FIXÉ ici, pas corrigé. `contientMarqueur` ne regarde que le texte :
  // rien ne distingue notre marqueur de la même chaîne recopiée par un tiers, et
  // l'API des commentaires ne donne pas l'auteur dans le champ qu'on lit.
  //
  // Assumé, pour deux raisons : l'exploiter demande de connaître `GITHUB_RUN_ID` ET
  // la tentative du run en cours, et la conséquence se borne à la perte d'un
  // commentaire de courtoisie sur un job DÉJÀ rouge — le verdict, lui, est rendu par
  // le code de sortie de `resolve.js` et par la croix du job, que rien ici ne touche.
  const execution = lancer('limite-imitation', {
    env: envIdempotence({
      GITHUB_RUN_ID: '222',
      GITHUB_RUN_ATTEMPT: '1',
      GH_STUB_COMMENTAIRES: 'libre',
      GH_STUB_CORPS_COMMENTAIRE: `Bien vu 👍\n${marqueurPorte('222-1')}`,
    }),
  });

  verifierCodeZero(execution);
  verifierDecision(execution, false);
});

// ═════════════════════════════════════════════════════════════════════════════
// D. La cible : pull request si elle existe, issue sinon
//
// `publierCompteRendu` poste sur l'une ou sur l'autre selon `bilan.numeroPr` :
// chercher d'un seul côté republierait sur le chemin R4, où le compte rendu part
// sur l'issue.
// ═════════════════════════════════════════════════════════════════════════════

test('pull request trouvée : lecture ET publication partent sur la PR, avec --repo partout', () => {
  const execution = lancer('cible-pr', {
    env: envIdempotence({ GITHUB_RUN_ID: '222', GITHUB_RUN_ATTEMPT: '1' }),
  });

  verifierCodeZero(execution);
  verifierDecision(execution, true);
  verifierRepoPartout(execution);

  const liste = appelsPrList(execution.appels);
  assert.equal(liste.length, 1, execution.traces);
  // `--state all` et non `--state open` : une PR fermée entre-temps porte quand même
  // le compte rendu de `resolve.js`.
  assert.ok(
    liste[0].includes('--head') && liste[0][liste[0].indexOf('--head') + 1] === BRANCHE,
    `la PR doit être résolue par la BRANCHE, il n'y a pas de sortie NUMERO_PR` +
      `\n${execution.traces}`,
  );
  assert.ok(
    liste[0].includes('--state') && liste[0][liste[0].indexOf('--state') + 1] === 'all',
    `--state all : une PR fermée porte quand même le compte rendu\n${execution.traces}`,
  );

  assert.deepEqual(
    appelsLecture(execution.appels).map((a) => [a[0], a[1], a[2]]),
    [['pr', 'view', NUMERO_PR]],
    `la lecture doit viser la pull request\n${execution.traces}`,
  );
  assert.deepEqual(
    appelsPublication(execution.appels).map((a) => [a[0], a[1], a[2]]),
    [['pr', 'comment', NUMERO_PR]],
    `la publication doit viser la pull request\n${execution.traces}`,
  );
  // Pas d'assertion sur la phrase qui nomme la cible : l'argv relevé ci-dessus le dit
  // déjà, et sans dépendre d'un libellé.
});

test("aucune pull request : issue view puis issue comment sur NUMERO_ISSUE, avec --repo partout", () => {
  const execution = lancer('cible-issue', {
    env: {
      GH_STUB_PR_LIST: 'aucune',
      GITHUB_RUN_ID: '222',
      GITHUB_RUN_ATTEMPT: '1',
      GH_STUB_COMMENTAIRES: 'tiers',
    },
  });

  verifierCodeZero(execution);
  verifierDecision(execution, true);
  verifierRepoPartout(execution);

  assert.deepEqual(
    appelsLecture(execution.appels).map((a) => [a[0], a[1], a[2]]),
    [['issue', 'view', NUMERO_ISSUE]],
    `sans PR, la lecture doit viser l'issue — c'est le chemin R4\n${execution.traces}`,
  );
  assert.deepEqual(
    appelsPublication(execution.appels).map((a) => [a[0], a[1], a[2]]),
    [['issue', 'comment', NUMERO_ISSUE]],
    `sans PR, la publication doit viser l'issue\n${execution.traces}`,
  );
});

test("aucune pull request : un compte rendu déjà présent SUR L'ISSUE arrête aussi le script", () => {
  const execution = lancer('cible-issue-deja', {
    env: {
      GH_STUB_PR_LIST: 'aucune',
      GITHUB_RUN_ID: '222',
      GITHUB_RUN_ATTEMPT: '1',
      GH_STUB_COMMENTAIRES: 'marqueur-portee',
      GH_STUB_PORTEE_MARQUEUR: '222-1',
    },
  });

  verifierCodeZero(execution);
  verifierDecision(execution, false);
  // La cible se lit sur l'argv, pas sur la phrase du journal.
  assert.deepEqual(
    appelsLecture(execution.appels).map((a) => [a[0], a[1], a[2]]),
    [['issue', 'view', NUMERO_ISSUE]],
    `la lecture doit viser l'issue\n${execution.traces}`,
  );
});

test('plusieurs pull requests pour la branche : la plus récente, donc le plus grand numéro', () => {
  // Le stub sert 4, 12 puis 7. `Math.max` était tenu par rien : avec une seule PR
  // servie, le remplacer par `Math.min` laissait toute la suite verte. L'ordre des trois
  // entrées est choisi pour que 12 ne soit ni la première, ni la dernière, ni la plus
  // petite — « prendre la première », « prendre la dernière » et `Math.min` rougissent
  // donc tous les trois.
  //
  // `--state all` fait remonter les PR fermées : sur plusieurs PR pour la même branche,
  // la plus récente est celle du run courant, et c'est elle qui porte le compte rendu
  // de `resolve.js`. Viser une PR fermée d'un run antérieur republierait à côté.
  const execution = lancer('plusieurs-pr', {
    env: {
      GH_STUB_PR_LIST: 'plusieurs-pr',
      GITHUB_RUN_ID: '222',
      GITHUB_RUN_ATTEMPT: '1',
    },
  });

  verifierCodeZero(execution);
  verifierDecision(execution, true);
  verifierRepoPartout(execution);

  assert.deepEqual(
    appelsLecture(execution.appels).map((a) => [a[0], a[1], a[2]]),
    [['pr', 'view', '12']],
    `la lecture doit viser la pull request de plus grand numéro\n${execution.traces}`,
  );
  assert.deepEqual(
    appelsPublication(execution.appels).map((a) => [a[0], a[1], a[2]]),
    [['pr', 'comment', '12']],
    `la publication doit viser la pull request de plus grand numéro\n${execution.traces}`,
  );
  // Une réponse bien formée n'a rien à signaler : un avertissement ici voudrait dire que
  // le chemin nominal passe par une branche de dégradation.
  assert.deepEqual(annotations(execution.stdout, 'warning'), [], execution.traces);
});

test("« pr list » de forme inattendue : ::warning:: puis repli sur l'issue", () => {
  // Deux réponses BIEN FORMÉES en JSON mais inexploitables : un objet au lieu d'une
  // liste, et un `number` en chaîne (`Number.isInteger("12")` est faux). Ni l'une ni
  // l'autre ne veut dire « cette branche n'a pas de PR », et le repli muet renvoyait le
  // lecteur chercher une PR qui existait pourtant.
  for (const forme of ['objet', 'numero-chaine']) {
    const execution = lancer(`pr-list-${forme}`, {
      env: {
        GH_STUB_PR_LIST: forme,
        GITHUB_RUN_ID: '222',
        GITHUB_RUN_ATTEMPT: '1',
      },
    });

    verifierCodeZero(execution);
    verifierDecision(execution, true);
    verifierRepoPartout(execution);

    const avertissements = annotations(execution.stdout, 'warning');
    assert.equal(
      avertissements.length,
      1,
      `la réponse « ${forme} » n'est pas exploitable : le repli doit s'annoncer` +
        `\n${execution.traces}`,
    );
    assert.ok(
      avertissements[0].includes(BRANCHE),
      `l'avertissement doit nommer la branche interrogée\n${execution.traces}`,
    );
    assert.ok(
      avertissements[0].includes(`#${NUMERO_ISSUE}`),
      `l'avertissement doit nommer l'issue de repli\n${execution.traces}`,
    );
    // Et surtout : le numéro 12 qui traîne dans la réponse ne doit PAS être retenu. Une
    // forme inattendue dont on tire quand même un numéro ferait commenter une cible
    // devinée.
    assert.deepEqual(
      appelsPublication(execution.appels).map((a) => [a[0], a[1], a[2]]),
      [['issue', 'comment', NUMERO_ISSUE]],
      `aucun numéro ne doit être deviné dans une réponse inexploitable` +
        `\n${execution.traces}`,
    );
  }
});

test("« pr list » qui répond un tableau VIDE : aucun avertissement, repli silencieux", () => {
  // La contrepartie des deux cas ci-dessus, et elle compte autant : `[]` est une réponse
  // CLAIRE — « cette branche n'a pas de pull request », le chemin R4. Avertir ici
  // remplirait les logs de tous les jobs sans PR, et un avertissement qu'on apprend à
  // ignorer ne sert plus à rien le jour où il est vrai.
  const execution = lancer('pr-list-vide', {
    env: {
      GH_STUB_PR_LIST: 'aucune',
      GITHUB_RUN_ID: '222',
      GITHUB_RUN_ATTEMPT: '1',
    },
  });

  verifierCodeZero(execution);
  verifierDecision(execution, true);
  assert.deepEqual(
    annotations(execution.stdout, 'warning'),
    [],
    `un tableau vide est une réponse, pas une panne : rien à signaler` +
      `\n${execution.traces}`,
  );
  assert.deepEqual(
    appelsPublication(execution.appels).map((a) => [a[0], a[1], a[2]]),
    [['issue', 'comment', NUMERO_ISSUE]],
    execution.traces,
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// E. Dégradations
//
// Arbitrage écrit dans le script : le pire cas est un DOUBLON de commentaire,
// jamais un silence. Un doublon se voit et s'efface ; un silence laisse
// l'utilisateur devant une issue avec un 👀 et rien d'autre.
// ═════════════════════════════════════════════════════════════════════════════

test('lecture des commentaires impossible (code non nul) : ::warning:: puis publication', () => {
  const execution = lancer('degrade-lecture', {
    env: envIdempotence({
      GH_STUB_SCENARIO: 'echec-view',
      GITHUB_RUN_ID: '222',
      GITHUB_RUN_ATTEMPT: '1',
    }),
  });

  verifierCodeZero(execution);
  verifierDecision(execution, true);
  // Un ::warning:: est émis, et il nomme la cible. Le FAIT contrôlé est l'annotation
  // et l'entité qu'elle désigne, jamais sa formulation.
  const avertissements = annotations(execution.stdout, 'warning');
  assert.equal(
    avertissements.length,
    1,
    `la publication à l'aveugle doit être annoncée : c'est ce qui explique un doublon ` +
      `au relecteur\n${execution.traces}`,
  );
  assert.ok(
    avertissements[0].includes(`#${NUMERO_PR}`),
    `l'avertissement doit désigner la cible concernée\n${execution.traces}`,
  );
  // Et la résolution de la PR n'est PAS tombée avec la lecture : le scénario est
  // partiel exprès, sinon la cible changerait et le test prouverait autre chose.
  assert.equal(appelsPrList(execution.appels).length, 1, execution.traces);
});

test('lecture qui répond du non-JSON : deux ::warning:: puis publication', () => {
  // C'est ce que répondait le stub à `pr view` avant ce lot : `lib/gh.js` lève, et
  // un test d'idempotence écrit là-dessus serait FAUSSEMENT VERT — il verrait
  // « publié » quel que soit le marqueur. Conservé comme cas à part entière.
  const execution = lancer('degrade-json', {
    env: envIdempotence({
      GH_STUB_COMMENTAIRES: 'json-invalide',
      GITHUB_RUN_ID: '222',
      GITHUB_RUN_ATTEMPT: '1',
    }),
  });

  verifierCodeZero(execution);
  verifierDecision(execution, true);
  // DEUX avertissements, et c'est le compte qui est le fait : un pour la lecture qui a
  // levé, un pour la publication à l'aveugle. Le scénario `echec-view` n'en produit
  // qu'un — les deux chemins de dégradation ne se confondent donc pas, et aucun
  // libellé n'est cité pour le montrer.
  const avertissements = annotations(execution.stdout, 'warning');
  assert.equal(
    avertissements.length,
    2,
    `un avertissement pour la lecture qui a levé, un pour la publication à l'aveugle` +
      `\n${execution.traces}`,
  );
  // Une commande de workflow est MONO-LIGNE : le message d'erreur de `JSON.parse`
  // porte des retours à la ligne, qui doivent être encodés en %0A.
  assert.ok(
    avertissements[0].includes('%0A'),
    `un ::warning:: multi-ligne doit être encodé en %0A, sinon sa fin est perdue` +
      `\n${execution.traces}`,
  );
});

test("lecture qui répond un objet sans champ « comments » : ::warning:: puis publication", () => {
  const execution = lancer('degrade-sans-champ', {
    env: envIdempotence({
      GH_STUB_COMMENTAIRES: 'sans-champ',
      GITHUB_RUN_ID: '222',
      GITHUB_RUN_ATTEMPT: '1',
    }),
  });

  verifierCodeZero(execution);
  verifierDecision(execution, true);
  assert.equal(
    annotations(execution.stdout, 'warning').length,
    1,
    `une réponse de forme inattendue doit dégrader comme une lecture impossible : un ` +
      `::warning::, et la publication quand même\n${execution.traces}`,
  );
});

test('publication impossible : ::error::, corps présent dans les logs, code 0', () => {
  const execution = lancer('degrade-publication', {
    env: envIdempotence({
      GH_STUB_SCENARIO: 'echec-commentaire',
      GITHUB_RUN_ID: '222',
      GITHUB_RUN_ATTEMPT: '1',
    }),
  });

  // LE contrôle du lot : un échec de publication n'a pas à rougir un job dont la
  // validation est peut-être passée, et le verdict est déjà rendu ailleurs.
  verifierCodeZero(execution);

  assert.equal(
    appelsPublication(execution.appels).length,
    1,
    `la publication doit avoir été TENTÉE\n${execution.traces}`,
  );
  const erreurs = annotations(execution.stdout, 'error');
  assert.equal(erreurs.length, 1, `un ::error:: attendu\n${execution.traces}`);
  assert.ok(
    erreurs[0].includes('github-token'),
    `l'erreur doit nommer l'input à vérifier — une entité, pas une tournure` +
      `\n${execution.traces}`,
  );
  assert.ok(
    execution.stdout.includes(marqueurPorte('222-1')),
    `le corps doit rester dans les logs du job : c'est tout ce qui reste à ` +
      `l'utilisateur\n${execution.traces}`,
  );
});

test('GH_CLI pointé sur un binaire inexistant : ::error::, code 0', () => {
  const execution = lancer('degrade-gh-absent', {
    env: {
      GH_CLI: path.join(TEMP, 'gh-qui-nexiste-pas'),
      GITHUB_RUN_ID: '222',
      GITHUB_RUN_ATTEMPT: '1',
    },
  });

  verifierCodeZero(execution);
  verifierAucunAppelGh(execution, 'le binaire ne se lance pas, donc rien à journaliser');
  assert.equal(
    annotations(execution.stdout, 'error').length,
    1,
    `un ::error:: attendu\n${execution.traces}`,
  );
  assert.ok(
    execution.stdout.includes(marqueurPorte('222-1')),
    `le corps doit rester dans les logs\n${execution.traces}`,
  );
});

test("« pr list » en échec : un ::warning:: nommant la branche et l'issue, puis repli sur l'issue", () => {
  // Ce test remplace un test épinglé qui NIAIT le libellé de l'ancien avertissement
  // (« Impossible de retrouver la pull request … »). Le défaut a été corrigé, le
  // nouveau message est rédigé autrement, et l'assertion négative est donc restée
  // VERTE en validant un comportement disparu. C'est le faux vert le plus coûteux du
  // fichier, et la raison pour laquelle plus rien ici n'est asserté sur une phrase.
  //
  // `lib/gh.js:68` rend `null` — pas une exception — sur un code de sortie non nul
  // quand `tolererEchec` est posé. `null` (« gh n'a pas répondu ») et `[]` (« cette
  // branche n'a pas de PR ») ne disent pas la même chose : les confondre faisait
  // partir le compte rendu sur l'issue sans une ligne pour dire pourquoi, et le
  // lecteur cherchait une PR qui existait pourtant.
  const execution = lancer('pr-list-echec', {
    env: {
      GH_STUB_PR_LIST: 'echec',
      GITHUB_RUN_ID: '222',
      GITHUB_RUN_ATTEMPT: '1',
    },
  });

  verifierCodeZero(execution);
  verifierDecision(execution, true);
  verifierRepoPartout(execution);

  // Le fait : une annotation `::warning::` est émise. Contrôlée par son PRÉFIXE et
  // par les entités qu'elle nomme — la branche interrogée et l'issue de repli —,
  // jamais par sa formulation.
  const avertissements = annotations(execution.stdout, 'warning');
  assert.equal(
    avertissements.length,
    1,
    `un « pr list » sans réponse doit s'annoncer : le repli sur l'issue est le bon ` +
      `arbitrage, c'est son SILENCE qui était le défaut\n${execution.traces}`,
  );
  assert.ok(
    avertissements[0].includes(BRANCHE),
    `l'avertissement doit nommer la branche dont la pull request n'a pas pu être ` +
      `résolue\n${execution.traces}`,
  );
  assert.ok(
    avertissements[0].includes(`#${NUMERO_ISSUE}`),
    `l'avertissement doit nommer l'issue sur laquelle le compte rendu se replie` +
      `\n${execution.traces}`,
  );

  // Et le repli lui-même, lu sur l'argv : l'issue existe toujours, la PR peut-être
  // pas. Le pire cas reste un doublon, jamais un silence.
  assert.deepEqual(
    appelsLecture(execution.appels).map((a) => [a[0], a[1], a[2]]),
    [['issue', 'view', NUMERO_ISSUE]],
    `la lecture doit se replier sur l'issue\n${execution.traces}`,
  );
  assert.deepEqual(
    appelsPublication(execution.appels).map((a) => [a[0], a[1], a[2]]),
    [['issue', 'comment', NUMERO_ISSUE]],
    `la publication doit se replier sur l'issue\n${execution.traces}`,
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// F. Le texte publié, et l'accord de forme entre les deux fichiers
// ═════════════════════════════════════════════════════════════════════════════

test("le corps se termine par le marqueur, et n'en contient qu'un", () => {
  const execution = lancer('texte-marqueur-unique', {
    env: envIdempotence({ GITHUB_RUN_ID: '222', GITHUB_RUN_ATTEMPT: '1' }),
  });

  verifierCodeZero(execution);
  assert.equal(execution.corps.length, 1, execution.traces);

  const corps = execution.corps[0];
  assert.ok(
    corps.endsWith(marqueurPorte('222-1')),
    `le marqueur doit terminer le corps : c'est ce qui le rend invisible dans le rendu ` +
      `GitHub et repérable par la lecture suivante\n${execution.traces}`,
  );
  assert.equal(
    compter(corps, 'deepseek-resolve:compte-rendu'),
    1,
    `un SEUL marqueur : deux marqueurs dans le même commentaire rendraient la portée ` +
      `ambiguë\n${execution.traces}`,
  );
  assert.equal(compter(corps, '<!--'), 1, execution.traces);
  assert.equal(compter(corps, '-->'), 1, execution.traces);
});

test('STATUT_JOB hostile : mono-ligne, masqué, borné, et le span de code reste fermé', () => {
  // 36 caractères après le préfixe : c'est la longueur que reconnaît le motif de
  // `masquerSecrets`. Un faux jeton, jamais un vrai — ce fichier est versionné.
  const fauxJeton = `ghp_${'A'.repeat(36)}`;
  // Les caractères dangereux sont placés au TOUT DÉBUT et à la TOUTE FIN de la valeur,
  // pas au milieu. `tronquer` ne garde qu'une tête et une queue de quelques caractères
  // chacune : une première version de ce test les mettait au milieu, ils tombaient dans
  // la partie retirée, et le test restait vert alors que `citerValeur` ne nettoyait
  // plus rien. Mesuré — retirer `.replace(/[`|<>]/g, ' ')` du script ne faisait rougir
  // aucun test.
  const statut = [
    '`<--> premiere ligne',
    `milieu | ${fauxJeton}`,
    // Espaces à dessein : sans eux, le motif base64 de `masquerSecrets` avalerait
    // toute la queue et la BORNE ne serait plus exercée.
    `queue ${'ab '.repeat(200)}|<-->\``,
  ].join('\n');

  const execution = lancer('texte-statut-hostile', {
    env: envIdempotence({
      STATUT_JOB: statut,
      GITHUB_RUN_ID: '222',
      GITHUB_RUN_ATTEMPT: '1',
    }),
  });

  verifierCodeZero(execution);
  assert.equal(execution.corps.length, 1, execution.traces);

  const corps = execution.corps[0];
  const premiereLigne = corps.split('\n')[0];

  // Mono-ligne, prouvé par un FAIT et non par la fin de phrase attendue : un statut de
  // trois lignes ne doit pas ajouter une seule ligne au corps. Le témoin est un run
  // identique avec un statut anodin qui prend la même branche de `phraseDuStatut`.
  const temoin = lancer('texte-statut-temoin', {
    env: envIdempotence({
      STATUT_JOB: 'inattendu',
      GITHUB_RUN_ID: '222',
      GITHUB_RUN_ATTEMPT: '1',
    }),
  });
  verifierCodeZero(temoin);
  assert.equal(
    corps.split('\n').length,
    temoin.corps[0].split('\n').length,
    `un statut multi-ligne ne doit pas ajouter de ligne au corps : la suite serait ` +
      `rendue en markdown, hors du span de code\n${execution.traces}`,
  );

  // Et aucun fragment du statut injecté ne se retrouve après la première ligne, où le
  // span de code le contient.
  for (const fragment of ['premiere', 'milieu', 'queue', 'ab ab']) {
    const fuites = corps
      .split('\n')
      .slice(1)
      .filter((ligne) => ligne.includes(fragment));
    assert.deepEqual(
      fuites,
      [],
      `le fragment « ${fragment} » du statut ne doit pas sortir de la première ligne` +
        `\n${execution.traces}`,
    );
  }

  // Le span de code reste fermé : exactement deux backticks sur la ligne.
  assert.equal(
    compter(premiereLigne, '`'),
    2,
    `les backticks du statut doivent être retirés, sinon le span où il est inséré se ` +
      `referme en avance\n${execution.traces}`,
  );

  // Bornée : la valeur citée ne dépasse pas la borne du script.
  const cite = premiereLigne.match(/\(`([^`]*)`\)/);
  assert.ok(cite, `la valeur doit être citée dans un span de code\n${execution.traces}`);
  assert.ok(
    cite[1].length <= 40,
    `la valeur citée doit être bornée ; obtenu ${cite[1].length} caractères` +
      `\n${execution.traces}`,
  );

  // Masquée : aucune trace du faux jeton, ni dans le corps publié, ni dans les logs
  // du job — un commentaire de dépôt public est lu par tout le monde (R7).
  for (const [ou, texte] of [
    ['le corps publié', corps],
    ['stdout', execution.stdout],
    ['stderr', execution.stderr],
  ]) {
    assert.ok(
      !texte.includes(fauxJeton) && !texte.includes('ghp_'),
      `le faux jeton ne doit pas apparaître dans ${ou}\n${execution.traces}`,
    );
  }

  // Le commentaire HTML du marqueur reste le seul, et il n'est pas refermé en avance
  // par le « --> » du statut.
  assert.equal(compter(corps, '-->'), 1, execution.traces);
  assert.ok(
    corps.endsWith(marqueurPorte('222-1')),
    `le marqueur doit rester en fin de corps\n${execution.traces}`,
  );
  assert.ok(
    !premiereLigne.includes('-->'),
    `« --> » doit être neutralisé dans la valeur citée\n${execution.traces}`,
  );
});

test('STATUT_JOB court : rien n\'est tronqué, donc le nettoyage est le seul à agir', () => {
  // Contre-épreuve du cas précédent. Sous la borne, `tronquer` rend la chaîne telle
  // quelle : tout ce qui reste dans la valeur citée y est parce que `citerValeur` l'a
  // laissé passer, et rien n'est masqué par un effet de bord de la troncature. C'est
  // le seul cas où l'on peut conclure quelque chose de l'ABSENCE d'un caractère.
  const statut = '`x` --> |y| <z>';

  const execution = lancer('texte-statut-court', {
    env: envIdempotence({
      STATUT_JOB: statut,
      GITHUB_RUN_ID: '222',
      GITHUB_RUN_ATTEMPT: '1',
    }),
  });

  verifierCodeZero(execution);
  const corps = execution.corps[0];
  const premiereLigne = corps.split('\n')[0];
  const cite = premiereLigne.match(/\(`([^`]*)`\)/);
  assert.ok(cite, `la valeur doit être citée dans un span de code\n${execution.traces}`);

  // Le span de code reste fermé : les deux seuls backticks de la ligne sont les siens.
  assert.equal(
    compter(premiereLigne, '`'),
    2,
    `un backtick venu du statut refermerait le span en avance, et la suite de la ` +
      `phrase serait rendue en markdown\n${execution.traces}`,
  );
  // `<` et `>` : un « --> » rouvrirait ou refermerait un commentaire HTML, et un
  // « <z> » serait pris pour une balise par le rendu GitHub.
  for (const caractere of ['<', '>', '|']) {
    assert.ok(
      !cite[1].includes(caractere),
      `« ${caractere} » doit être retiré de la valeur citée ; obtenu ` +
        `${JSON.stringify(cite[1])}\n${execution.traces}`,
    );
  }
  assert.equal(
    compter(corps, '-->'),
    1,
    `le seul « --> » du corps est celui qui ferme le marqueur\n${execution.traces}`,
  );
  // Les lettres, elles, sont conservées : un nettoyage qui viderait la valeur passerait
  // toutes les assertions ci-dessus sans rien dire au lecteur du compte rendu.
  for (const lettre of ['x', 'y', 'z']) {
    assert.ok(
      cite[1].includes(lettre),
      `le contenu lisible du statut doit être conservé\n${execution.traces}`,
    );
  }
});

test('STATUT_JOB réduit à un faux jeton : masqué, et sous la borne donc non tronqué', () => {
  // 40 caractères pile : `tronquer` rend une chaîne de 40 caractères telle quelle, donc
  // la troncature ne peut PAS être ce qui fait disparaître le jeton. C'est ce qui rend
  // l'absence de « ghp_ » concluante ici, alors qu'elle ne l'est pas dans le cas long,
  // où le milieu de la valeur est retiré de toute façon.
  //
  // La propriété contrôlée est de bout en bout — « aucun jeton dans le commentaire ni
  // dans les logs » — et non un appel précis. Mesuré : le masquage est posé sur TROIS
  // couches (`citerValeur`, `journaliser`, `avecFichierCorps`) et retirer l'une des
  // trois ne fait rien fuir ; ce test rougit quand les trois sautent. C'est la bonne
  // granularité : R7 est une propriété du texte publié, pas d'une ligne de code.
  const fauxJeton = `ghp_${'A'.repeat(36)}`;
  assert.equal(fauxJeton.length, 40, 'le faux jeton doit tenir pile dans la borne');

  const execution = lancer('texte-statut-jeton', {
    env: envIdempotence({
      STATUT_JOB: fauxJeton,
      GITHUB_RUN_ID: '222',
      GITHUB_RUN_ATTEMPT: '1',
    }),
  });

  verifierCodeZero(execution);
  for (const [ou, texte] of [
    ['le corps publié', execution.corps[0]],
    ['stdout', execution.stdout],
    ['stderr', execution.stderr],
  ]) {
    assert.ok(
      !texte.includes('ghp_'),
      `un jeton du job ne doit atteindre ni le commentaire ni les logs (R7) : ` +
        `${ou}\n${execution.traces}`,
    );
  }
  // Et la valeur citée n'est pas vide : elle porte la trace du masquage, sinon le
  // lecteur du compte rendu ne sait pas qu'il y avait quelque chose.
  const cite = execution.corps[0].split('\n')[0].match(/\(`([^`]*)`\)/);
  assert.ok(cite, `la valeur doit rester citée\n${execution.traces}`);
  assert.notEqual(cite[1], '(vide)', execution.traces);
});

test('les trois régimes de STATUT_JOB rendent trois phrases distinctes deux à deux', () => {
  // `phraseDuStatut` a trois branches, et le lot 4 demande au corps de porter la
  // distinction : un job ANNULÉ — ou dont le `timeout-minutes` du consommateur est
  // tombé — rapporté « le job a échoué » envoie l'utilisateur chercher une panne là où
  // il n'y a qu'un délai dépassé.
  //
  // Deux faits sont contrôlés, et il faut les DEUX :
  //
  //   1. les trois premières lignes sont distinctes deux à deux. Attrape
  //      l'effondrement des trois branches en une seule ;
  //   2. un statut RECONNU n'est jamais recité au lecteur : sa phrase ne porte aucun
  //      span de code et n'écho pas la valeur reçue. Seul le régime « inattendu » cite
  //      ce qu'il a reçu, parce que c'est la seule chose qu'il sache en dire.
  //
  // Le fait 1 seul ne suffit PAS, et c'est mesuré : en neutralisant le test de
  // « cancelled », ce statut tombe dans la branche « inattendu » et rend « … statut
  // inattendu (`cancelled`) … » — une phrase encore distincte des deux autres, puisque
  // la valeur citée diffère. C'est le fait 2 qui rougit alors.
  const statutInattendu = 'etrange-42';
  const reconnus = ['cancelled', 'failure'];
  const executions = new Map();

  for (const statut of [...reconnus, statutInattendu]) {
    const execution = lancer(`regime-${encodeURIComponent(statut)}`, {
      env: envIdempotence({
        STATUT_JOB: statut,
        GITHUB_RUN_ID: '222',
        GITHUB_RUN_ATTEMPT: '1',
      }),
    });
    verifierCodeZero(execution);
    verifierDecision(execution, true);
    executions.set(statut, execution);
  }

  const premiereLigne = (statut) => executions.get(statut).corps[0].split('\n')[0];

  // Fait 1 : distinctes deux à deux.
  const statuts = [...executions.keys()];
  for (let i = 0; i < statuts.length; i += 1) {
    for (let j = i + 1; j < statuts.length; j += 1) {
      assert.notEqual(
        premiereLigne(statuts[i]),
        premiereLigne(statuts[j]),
        `STATUT_JOB=${JSON.stringify(statuts[i])} et ${JSON.stringify(statuts[j])} doivent ` +
          `donner deux phrases différentes : « annulé » et « échoué » ne sont pas la même ` +
          `nouvelle pour l'utilisateur\n${executions.get(statuts[i]).traces}`,
      );
    }
  }

  // Fait 2 : un statut reconnu n'est pas recité.
  for (const statut of reconnus) {
    const ligne = premiereLigne(statut);
    assert.equal(
      compter(ligne, '`'),
      0,
      `STATUT_JOB=${JSON.stringify(statut)} est un statut RECONNU : sa phrase le nomme en ` +
        `clair et n'a rien à citer. Un span de code ici veut dire que la valeur est ` +
        `retombée dans la branche « statut inattendu »\n${executions.get(statut).traces}`,
    );
    assert.ok(
      !ligne.includes(statut),
      `STATUT_JOB=${JSON.stringify(statut)} ne doit pas être renvoyé tel quel à ` +
        `l'utilisateur : la phrase doit dire ce que ce statut SIGNIFIE` +
        `\n${executions.get(statut).traces}`,
    );
  }

  // Et le régime inattendu, lui, cite ce qu'il a reçu — c'est tout ce qu'il sait.
  const ligneInattendue = premiereLigne(statutInattendu);
  const cite = ligneInattendue.match(/\(`([^`]*)`\)/);
  assert.ok(
    cite,
    `un statut inconnu doit être cité : sans lui, le lecteur des logs ne peut pas ` +
      `savoir ce que le runner a envoyé\n${executions.get(statutInattendu).traces}`,
  );
  assert.equal(cite[1], statutInattendu, executions.get(statutInattendu).traces);
});

// ─── Accord de forme entre `rendre-compte.js` et `resolve.js` ────────────────
//
// Le seul contrôle qui empêche les deux fichiers de diverger. Deux formes
// divergentes font publier un second compte rendu à chaque job rouge, sans qu'aucun
// autre test ne rougisse : `resolve.js` écrirait une forme que `rendre-compte.js` ne
// reconnaîtrait pas. Le contrat l'exige, et `resolve.js` exporte
// `marqueurCompteRendu` pour ça.
//
// Les deux modules sont chargés EN PROCESSUS ici, à l'inverse du reste du fichier :
// on compare des formes, pas des comportements, et `resolve.js` lit l'environnement
// au moment de l'appel.

const {
  marqueurCompteRendu: marqueurResolve,
} = require('../scripts/resolve.js');
const {
  marqueurCompteRendu: marqueurRendreCompte,
  porteeDuRun,
  MARQUEUR_COMPTE_RENDU,
  contientMarqueur,
} = require('../scripts/rendre-compte.js');

/**
 * Évalue les deux formes sous un environnement donné, puis restaure. `null` supprime
 * la variable : une variable absente n'est pas une variable vide.
 * @param {Record<string, string|null>} variables
 */
function sousEnvironnement(variables, fn) {
  const sauvegarde = {
    GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
    GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT,
  };
  try {
    for (const [cle, valeur] of Object.entries(variables)) {
      if (valeur === null) delete process.env[cle];
      else process.env[cle] = valeur;
    }
    return fn();
  } finally {
    for (const [cle, valeur] of Object.entries(sauvegarde)) {
      if (valeur === undefined) delete process.env[cle];
      else process.env[cle] = valeur;
    }
  }
}

test('resolve.js et rendre-compte.js écrivent le MÊME marqueur, caractère par caractère', () => {
  const environnements = [
    // Portée valide.
    [{ GITHUB_RUN_ID: '222', GITHUB_RUN_ATTEMPT: '1' }, marqueurPorte('222-1')],
    [{ GITHUB_RUN_ID: '9876543210', GITHUB_RUN_ATTEMPT: '12' }, marqueurPorte('9876543210-12')],
    // Portée absente : run local, harnais de test.
    [{ GITHUB_RUN_ID: null, GITHUB_RUN_ATTEMPT: null }, MARQUEUR_NU],
    [{ GITHUB_RUN_ID: '222', GITHUB_RUN_ATTEMPT: null }, MARQUEUR_NU],
    [{ GITHUB_RUN_ID: null, GITHUB_RUN_ATTEMPT: '1' }, MARQUEUR_NU],
    [{ GITHUB_RUN_ID: '', GITHUB_RUN_ATTEMPT: '' }, MARQUEUR_NU],
    // Portée invalide : traitée comme une absence, des deux côtés.
    [{ GITHUB_RUN_ID: 'abc', GITHUB_RUN_ATTEMPT: '1' }, MARQUEUR_NU],
    [{ GITHUB_RUN_ID: '222', GITHUB_RUN_ATTEMPT: 'x' }, MARQUEUR_NU],
    [{ GITHUB_RUN_ID: '222 --> visible', GITHUB_RUN_ATTEMPT: '1' }, MARQUEUR_NU],
    [{ GITHUB_RUN_ID: '2.2', GITHUB_RUN_ATTEMPT: '1' }, MARQUEUR_NU],
  ];

  for (const [variables, attendu] of environnements) {
    const { cote, contre, portee } = sousEnvironnement(variables, () => ({
      cote: marqueurResolve(),
      contre: marqueurRendreCompte(porteeDuRun()),
      portee: porteeDuRun(),
    }));

    const contexte = `environnement ${JSON.stringify(variables)} (portée « ${portee} »)`;

    assert.equal(
      contre,
      cote,
      `${contexte} : rendre-compte.js et resolve.js doivent écrire la MÊME forme. ` +
        'Deux formes divergentes font publier un doublon à chaque job rouge, et rien ' +
        "d'autre ne l'attrape.",
    );
    // Et les deux sont comparées au LITTÉRAL du contrat : deux fichiers mutés de la
    // même façon resteraient d'accord entre eux, et faux tous les deux.
    assert.equal(cote, attendu, `${contexte} : forme de resolve.js contre plan/contrat.md`);
    assert.equal(contre, attendu, `${contexte} : forme de rendre-compte.js contre plan/contrat.md`);
  }
});

// Programme minimal qui fait écrire à `publierCompteRendu` son corps et rien d'autre.
//
// Sous `sansPublication`, la primitive journalise le corps et n'appelle aucun `gh` :
// le corps est donc lisible sur stdout, hors ligne, sans jeton et sans réseau.
//
// Lancé en SOUS-PROCESSUS, parce que `marqueurCompteRendu()` de `resolve.js` lit
// l'environnement au moment de l'appel : un `process.env` réécrit dans le processus de
// test ne prouverait pas ce que fait un runner, qui reçoit ces variables au lancement.
//
// Le chemin passe par l'environnement plutôt que par le texte du programme : un chemin
// absolu concaténé dans une chaîne de code est le genre de détail qui casse dès qu'un
// répertoire porte une apostrophe.
const PROGRAMME_PUBLIER_COMPTE_RENDU = [
  "const { publierCompteRendu } = require(process.env.CHEMIN_RESOLVE);",
  "publierCompteRendu(",
  "  { numeroIssue: 7, sansPublication: true, depot: 'proprietaire/depot',",
  "    branche: 'fix-issue-7' },",
  "  { succes: false, iterations: 2, maxIterations: 2,",
  "    motif: 'la validation ne passe pas', refuses: [], numeroPr: 9 },",
  ");",
].join('\n');

/**
 * Fait écrire à `publierCompteRendu` (lot 3b, `scripts/resolve.js`) son corps sous une
 * portée donnée, et le rend.
 *
 * @param {Record<string, string|null>} variables `GITHUB_RUN_ID` / `GITHUB_RUN_ATTEMPT`
 * @returns {{ resultat: object, corps: string, traces: string }}
 */
function corpsDePublierCompteRendu(variables) {
  const environnement = {
    PATH: process.env.PATH,
    HOME: process.env.HOME || TEMP,
    CHEMIN_RESOLVE: path.join(RACINE, 'scripts', 'resolve.js'),
    ...variables,
  };
  for (const [cle, valeur] of Object.entries(environnement)) {
    if (valeur === null || valeur === undefined) delete environnement[cle];
  }

  const resultat = spawnSync(process.execPath, ['-e', PROGRAMME_PUBLIER_COMPTE_RENDU], {
    cwd: RACINE,
    encoding: 'utf8',
    shell: false,
    env: environnement,
  });

  const traces = `--- stdout ---\n${resultat.stdout}\n--- stderr ---\n${resultat.stderr}`;
  assert.equal(resultat.status, 0, `publierCompteRendu a échoué\n${traces}`);
  return { resultat, corps: resultat.stdout.trimEnd(), traces };
}

test('le corps écrit par publierCompteRendu porte le marqueur PORTÉ, pas la forme nue', () => {
  // LE cas qui manquait, et le trou était bloquant : remplacer
  // `lignes.push(marqueurCompteRendu())` par `lignes.push(MARQUEUR_COMPTE_RENDU)` dans
  // `publierCompteRendu` laissait `boucle` (58) et ce fichier (37) entièrement verts.
  //
  // Sur un runner, `resolve.js` aurait alors écrit la forme NUE et `rendre-compte.js`
  // aurait cherché la forme PORTÉE : un second compte rendu à CHAQUE job rouge, c'est-
  // à-dire la panne complète du mécanisme que la sous-section « Pourquoi le marqueur
  // porte la portée du run » du contrat existe pour fermer.
  //
  // Deux raisons au trou, et il fallait les deux : `test/boucle.test.js` construit son
  // environnement sans les variables de run, donc il épingle légitimement la forme nue ;
  // et le contrôle d'accord de ce fichier ne comparait que les deux FONCTIONS, jamais le
  // corps réellement écrit. Une fonction juste appelée nulle part ne sert à rien.
  //
  // L'attendu est construit ICI, depuis la portée que le test pose. Le reprendre de
  // `resolve.js` ferait propager la mutation à l'attendu, et le test resterait vert.
  const { corps, traces } = corpsDePublierCompteRendu({
    GITHUB_RUN_ID: '222',
    GITHUB_RUN_ATTEMPT: '3',
  });

  assert.equal(
    corps.split('\n').pop(),
    marqueurPorte('222-3'),
    `la dernière ligne du corps de publierCompteRendu doit être le marqueur de la portée ` +
      `courante\n${traces}`,
  );
  assert.ok(
    !corps.includes(MARQUEUR_NU),
    `le corps ne doit pas porter la forme NUE quand la portée est connue : c'est elle ` +
      `qui distingue ce compte rendu de celui d'un run précédent sur la même PR` +
      `\n${traces}`,
  );

  // La boucle fermée, et c'est la vraie propriété : ce que `resolve.js` ÉCRIT est ce que
  // `rendre-compte.js` RECONNAÎT, sous la même portée et sous elle seule.
  assert.equal(
    contientMarqueur(corps, '222-3'),
    true,
    `rendre-compte.js doit reconnaître le compte rendu de CE run\n${traces}`,
  );
  assert.equal(
    contientMarqueur(corps, '222-4'),
    false,
    `une autre TENTATIVE du même run est un autre verdict : elle ne doit pas se ` +
      `reconnaître dans ce compte rendu\n${traces}`,
  );
  assert.equal(
    contientMarqueur(corps, '111-1'),
    false,
    `un autre run ne doit pas se reconnaître dans ce compte rendu\n${traces}`,
  );
});

test('sans portée, le corps écrit par publierCompteRendu porte la forme nue', () => {
  // Le régime local et de test. Il est déjà couvert par `test/boucle.test.js`, mais
  // c'est justement lui qui laissait passer la mutation : sans le cas porté ci-dessus,
  // épingler cette forme-là ne prouve rien.
  const { corps, traces } = corpsDePublierCompteRendu({
    GITHUB_RUN_ID: null,
    GITHUB_RUN_ATTEMPT: null,
  });

  assert.equal(corps.split('\n').pop(), MARQUEUR_NU, traces);
  assert.equal(
    contientMarqueur(corps, ''),
    true,
    `en régime de repli, n'importe quel compte rendu compte\n${traces}`,
  );
});

test('la forme nue exportée est celle du contrat', () => {
  assert.equal(MARQUEUR_COMPTE_RENDU, MARQUEUR_NU);
});

test('le marqueur RÉELLEMENT publié est celui que resolve.js écrirait', () => {
  // Boucle fermée : la comparaison ci-dessus porte sur deux fonctions, celle-ci sur
  // le texte que le script a effectivement passé à `gh --body-file`. C'est elle qui
  // attrape un corps construit à côté de `marqueurCompteRendu`.
  const environnements = [
    { GITHUB_RUN_ID: '222', GITHUB_RUN_ATTEMPT: '1' },
    { GITHUB_RUN_ID: '222', GITHUB_RUN_ATTEMPT: '7' },
    { GITHUB_RUN_ID: null, GITHUB_RUN_ATTEMPT: null },
    { GITHUB_RUN_ID: 'abc', GITHUB_RUN_ATTEMPT: '1' },
  ];

  for (let rang = 0; rang < environnements.length; rang += 1) {
    const variables = environnements[rang];
    const attendu = sousEnvironnement(variables, () => marqueurResolve());
    // Un identifiant de cas par rang : deux cas qui partagent un journal de stub
    // mélangent leurs appels.
    const execution = lancer(`accord-publie-${rang}`, {
      env: envIdempotence(variables),
    });

    verifierCodeZero(execution);
    assert.equal(execution.corps.length, 1, execution.traces);
    assert.equal(
      execution.corps[0].split('\n').pop(),
      attendu,
      `sous ${JSON.stringify(variables)}, la dernière ligne du corps publié doit être ` +
        `exactement le marqueur de resolve.js\n${execution.traces}`,
    );
  }
});
