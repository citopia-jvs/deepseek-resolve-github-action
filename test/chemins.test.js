'use strict';

// Harnais de test de `scripts/lib/chemins.js` — lot 1.
//
// Node pur, bibliothèque standard uniquement (`node:test`, `node:assert`),
// CommonJS, aucune dépendance npm. Lancement :
//
//   node test/chemins.test.js
//
// Test UNITAIRE : ni sous-processus, ni dépôt jetable, ni stub. `normaliser` et
// `estCheminInterdit` sont des fonctions pures à un détail près — elles font des
// `lstat` sur des chemins RELATIFS pour refuser les liens symboliques — d'où le
// `process.chdir` ci-dessous vers un répertoire vide : sans lui, un fichier du
// dépôt courant pourrait changer le résultat d'un cas.
//
// ─── Pourquoi ce fichier existe ──────────────────────────────────────────────
//
// Relevé en écrivant `test/boucle.test.js` : la boucle n'exerce que cinq entrées
// de la liste interdite (`.github/workflows/**`, `.aider.conf.yml`, `.env`,
// `package.json`, `Makefile`). Retirer `Jenkinsfile`, `renovate.json` ou
// `.github/actions/**` de la liste ne faisait rougir aucun test. La liste EST la
// mesure de R3 et de R8 : elle a besoin de son propre harnais, au niveau où elle
// est écrite.
//
// Le dernier cas est un contrôle de COUVERTURE et non de comportement : il relit
// les trois tableaux dans la source et exige que chaque entrée soit exercée par au
// moins un chemin du tableau `INTERDITS`. Sans lui, une entrée ajoutée demain
// n'aurait toujours aucun test.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RACINE = path.resolve(__dirname, '..');
const SOURCE_CHEMINS = path.join(RACINE, 'scripts', 'lib', 'chemins.js');
const { normaliser, estCheminInterdit } = require(SOURCE_CHEMINS);

// Répertoire vide et hors du dépôt : les `lstat` de `refuserLiens` partent du
// répertoire courant, et ce test ne doit rien devoir à ce qu'il contient.
const TEMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chemins-test-')));
process.chdir(TEMP);

// ═════════════════════════════════════════════════════════════════════════════
// Les chemins refusés, un par entrée de la liste — et à profondeur non nulle là
// où la règle le prévoit.
// ═════════════════════════════════════════════════════════════════════════════

const INTERDITS = [
  // ── Répertoires interdits : le répertoire lui-même et tout son contenu ──────
  '.github/workflows',
  '.github/workflows/ci.yml',
  '.github/workflows/interne/reutilisable.yml',
  '.github/actions',
  '.github/actions/mon-action/index.js',
  '.circleci/config.yml',
  '.buildkite/pipeline.yml',
  '.husky/pre-commit',
  '.devcontainer/devcontainer.json',

  // ── Chemins ancrés à la racine ─────────────────────────────────────────────
  '.github/settings.yml',
  '.github/dependabot.yml',

  // ── Actions ────────────────────────────────────────────────────────────────
  'action.yml',
  'action.yaml',
  // Nom nu, donc à toute profondeur : une action composite dans un sous-dossier
  // est exécutée par tous les workflows qui l'appellent.
  'outils/mon-action/action.yml',

  // ── CI hors GitHub ─────────────────────────────────────────────────────────
  '.gitlab-ci.yml',
  'Jenkinsfile',
  'sous/projet/Jenkinsfile',
  'azure-pipelines.yml',
  '.travis.yml',
  'bitbucket-pipelines.yml',
  '.drone.yml',

  // ── Gouvernance ────────────────────────────────────────────────────────────
  'CODEOWNERS',
  // GitHub honore .github/, la racine ET docs/ : les trois emplacements comptent.
  '.github/CODEOWNERS',
  'docs/CODEOWNERS',
  'renovate.json',

  // ── Exécuté à l'install ou au test ─────────────────────────────────────────
  'package.json',
  'sous/paquet/package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '.npmrc',
  '.yarnrc.yml',
  'requirements.txt',
  'requirements-dev.txt',
  'sous/requirements.txt',
  'pyproject.toml',
  'setup.py',
  'conftest.py',
  // `conftest.py` est un mécanisme PAR RÉPERTOIRE : la profondeur est le cas
  // normal, pas l'exception.
  'tests/unite/conftest.py',
  'sitecustomize.py',
  'tox.ini',
  'noxfile.py',
  'Gemfile',
  'Makefile',
  'sous/Makefile',
  'justfile',
  'Cargo.toml',
  'crates/moteur/Cargo.toml',
  'build.rs',
  'composer.json',

  // ── Configuration de test = code ───────────────────────────────────────────
  'jest.config.js',
  'jest.config.ts',
  'vitest.config.mts',
  '.mocharc.json',
  'karma.conf.js',
  'playwright.config.ts',

  // ── Hooks ──────────────────────────────────────────────────────────────────
  '.pre-commit-config.yaml',

  // ── Conteneurs ─────────────────────────────────────────────────────────────
  'Dockerfile',
  'Dockerfile.dev',
  'docker/Dockerfile',
  'docker-compose.yml',
  'docker-compose.prod.yaml',
  'compose.yaml',
  'compose.yml',

  // ── aider — R8 ─────────────────────────────────────────────────────────────
  '.aider.conf.yml',
  '.aider.model.metadata.json',
  // Le motif large : fichiers de travail d'aider. Avec `--no-gitignore`, ils
  // entraient dans le commit et, devenus suivis, n'en sortaient plus.
  '.aider.chat.history.md',
  '.aider.input.history',
  '.env',
  '.env.local',
  '.env.production',
];

// Refusés par le PREMIER SEGMENT et non par le nom de fichier : `cache.db` ne
// ressemble à rien d'interdit, c'est le répertoire qui l'est.
const INTERDITS_PAR_PREMIER_SEGMENT = [
  '.aider.tags.cache.v4/cache.db',
  '.aider.tags.cache.v4/cache.db-wal',
];

// Insensibilité à la casse : un système de fichiers insensible à la casse rendrait
// sinon `PACKAGE.JSON` acceptable.
const INTERDITS_AUTRE_CASSE = [
  'PACKAGE.JSON',
  'dockerfile',
  'MAKEFILE',
  'JenkinsFile',
  '.GitHub/Workflows/ci.yml',
  '.ENV',
  '.AIDER.CONF.YML',
];

// Entrées repliées par git. `-uall` déplie les répertoires non suivis ordinaires,
// mais PAS un dépôt git imbriqué : `?? imbrique/` reste une seule entrée, et
// `git add -- imbrique` enregistrerait un gitlink vers un commit absent du dépôt
// poussé.
const INTERDITS_REPLIES = ['imbrique/', 'sous/imbrique/', 'src/'];

// ═════════════════════════════════════════════════════════════════════════════
// La contre-épreuve : ce qui doit PASSER.
// ═════════════════════════════════════════════════════════════════════════════

const AUTORISES = [
  'src/index.js',
  'src/lib/calcul.js',
  'docs/aider.md',
  'test/truc.test.js',
  'README.md',
  '.github/ISSUE_TEMPLATE/bogue.md',
  '.github/pull_request_template.md',
  'scripts/deployer.sh',
  // Les deux fichiers livrés par l'action : ils ne portent PAS le préfixe « . »
  // précisément pour ne pas être à la fois livrés et interdits.
  'aider.conf.yml',
  'aider-models.json',
  // Bordures des motifs : `Makefile` et `.env` sont des noms EXACTS, `CODEOWNERS`
  // aussi. Un refus par simple préfixe emporterait ces trois-là.
  'Makefile.md',
  'docs/CODEOWNERS.md',
  'src/env.js',
  'config/environnement.json',
  'compose.md',
  'paquet.json',
];

test('chaque entrée de la liste interdite refuse son chemin', () => {
  for (const chemin of INTERDITS) {
    assert.equal(
      estCheminInterdit(chemin),
      true,
      `${chemin} doit être refusé : ce fichier est exécuté ou interprété ` +
        `automatiquement sans relecture humaine`,
    );
  }
});

test('un fichier de travail d’aider est refusé par son PREMIER SEGMENT (R8)', () => {
  for (const chemin of INTERDITS_PAR_PREMIER_SEGMENT) {
    assert.equal(
      estCheminInterdit(chemin),
      true,
      `${chemin} doit être refusé : son nom de fichier ne ressemble à rien ` +
        `d'interdit, c'est le répertoire d'aider qui l'est`,
    );
  }
});

test('la liste est insensible à la casse', () => {
  for (const chemin of INTERDITS_AUTRE_CASSE) {
    assert.equal(
      estCheminInterdit(chemin),
      true,
      `${chemin} doit être refusé : un système de fichiers insensible à la casse ` +
        `rendrait sinon cette variante acceptable`,
    );
  }
});

test('une entrée repliée par git (dépôt imbriqué) est refusée', () => {
  for (const chemin of INTERDITS_REPLIES) {
    assert.equal(
      estCheminInterdit(chemin),
      true,
      `${chemin} finit par « / » : c'est un répertoire replié, dont « git add » ` +
        `emporterait tout le contenu ou enregistrerait un gitlink cassé`,
    );
  }
});

test('les chemins ordinaires passent — un refus trop large casserait toute correction', () => {
  for (const chemin of AUTORISES) {
    assert.equal(
      estCheminInterdit(chemin),
      false,
      `${chemin} doit être AUTORISÉ : une liste trop large empêche le modèle de ` +
        `corriger quoi que ce soit, et le test resterait vert`,
    );
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// normaliser
// ═════════════════════════════════════════════════════════════════════════════

test('normaliser ramène à une forme POSIX relative', () => {
  assert.equal(normaliser('src/index.js'), 'src/index.js');
  assert.equal(normaliser('./src/index.js'), 'src/index.js');
  assert.equal(normaliser('src//index.js'), 'src/index.js');
  assert.equal(normaliser('src/'), 'src');
  assert.equal(normaliser('src///'), 'src');
  // Un « .. » que la normalisation absorbe ne sort pas du dépôt : il est admis.
  assert.equal(normaliser('a/b/../c.js'), 'a/c.js');
});

const REFUSES_PAR_NORMALISER = [
  ['', 'chaîne vide'],
  ['.', 'répertoire courant'],
  ['..', 'remontée nue'],
  ['../secrets.txt', 'remontée hors du dépôt'],
  ['a/../../secrets.txt', 'remontée hors du dépôt après normalisation'],
  ['/etc/passwd', 'chemin absolu POSIX'],
  ['//serveur/partage', 'chemin absolu POSIX (double barre)'],
  ['C:\\Windows\\system32', 'chemin absolu Windows'],
  ['\\\\serveur\\partage\\x', 'chemin UNC Windows'],
  [`src/index.js${String.fromCharCode(0)}.png`, 'octet nul'],
  ['.git/config', '.git en premier segment'],
  ['.git/hooks/pre-commit', 'sous .git/'],
  ['sous/.git/config', '.git à un segment quelconque'],
  ['sous/.GIT/config', '.git à un segment quelconque, autre casse'],
];

test('normaliser lève sur tout chemin qu’il ne sait pas juger', () => {
  for (const [chemin, pourquoi] of REFUSES_PAR_NORMALISER) {
    assert.throws(
      () => normaliser(chemin),
      `normaliser doit lever (${pourquoi}) : renvoyer une valeur de repli ferait ` +
        `traiter ce chemin comme sûr — reçu ${JSON.stringify(chemin)}`,
    );
  }
});

test('estCheminInterdit est fail-closed sur tout ce que normaliser refuse', () => {
  for (const [chemin, pourquoi] of REFUSES_PAR_NORMALISER) {
    assert.equal(
      estCheminInterdit(chemin),
      true,
      `${JSON.stringify(chemin)} (${pourquoi}) doit être refusé : un chemin qu'on ne ` +
        `sait pas juger ne doit pas être écrit`,
    );
  }
});

test('normaliser refuse ce qui n’est pas une chaîne', () => {
  for (const valeur of [undefined, null, 42, {}, [], ['src/index.js']]) {
    assert.throws(() => normaliser(valeur), `normaliser(${JSON.stringify(valeur)}) doit lever`);
    assert.equal(estCheminInterdit(valeur), true, `estCheminInterdit doit rester fail-closed`);
  }
});

test('un composant qui est un lien symbolique est refusé', (t) => {
  // Écrire à travers un lien modifie une cible que la liste interdite n'a pas vue :
  // `lien/package.json` peut pointer hors du dépôt.
  const cible = path.join(TEMP, 'cible-reelle');
  fs.mkdirSync(cible, { recursive: true });
  try {
    fs.symlinkSync(cible, path.join(TEMP, 'lien'));
  } catch (err) {
    // Droits insuffisants (Windows sans mode développeur, système de fichiers
    // exotique) : sauté proprement plutôt que rouge pour une mauvaise raison.
    t.skip(`création de lien symbolique impossible : ${err && err.message}`);
    return;
  }

  assert.throws(
    () => normaliser('lien/nouveau.js'),
    /[Ll]ien symbolique/,
    'un composant lien symbolique doit lever, même si le fichier final n’existe pas',
  );
  assert.equal(estCheminInterdit('lien/nouveau.js'), true);
  assert.equal(estCheminInterdit('lien'), true);
  // Contre-épreuve : un répertoire ORDINAIRE du même temporaire passe, sinon le
  // cas prouverait seulement que tout est refusé ici.
  fs.mkdirSync(path.join(TEMP, 'ordinaire'), { recursive: true });
  assert.equal(estCheminInterdit('ordinaire/nouveau.js'), false);
  assert.equal(normaliser('ordinaire/nouveau.js'), 'ordinaire/nouveau.js');
});

// ═════════════════════════════════════════════════════════════════════════════
// Couverture de la liste elle-même
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Relit un tableau de motifs dans la source de `chemins.js`.
 *
 * Les commentaires sont retirés avant l'extraction : ils contiennent des
 * apostrophes françaises qui casseraient la lecture des littéraux.
 */
function motifsDeLaSource(nomDuTableau) {
  const source = fs.readFileSync(SOURCE_CHEMINS, 'utf8');
  const debut = source.indexOf(`const ${nomDuTableau} = [`);
  assert.ok(debut !== -1, `${nomDuTableau} est introuvable dans ${SOURCE_CHEMINS}`);
  const fin = source.indexOf('];', debut);
  const region = source
    .slice(debut, fin)
    .split('\n')
    .map((ligne) => {
      const commentaire = ligne.indexOf('//');
      return commentaire === -1 ? ligne : ligne.slice(0, commentaire);
    })
    .join('\n');
  return [...region.matchAll(/'([^']*)'/g)].map((trouve) => trouve[1]).filter(Boolean);
}

/** Même sémantique de glob que `chemins.js` : `*` ne franchit pas `/`. */
function motifVersRegex(motif) {
  const source = motif.replace(/[\\^$.|?+()[\]{}]/g, '\\$&').split('*').join('[^/]*');
  return new RegExp(`^${source}$`, 'i');
}

test('chaque entrée des trois tableaux est exercée par au moins un cas', () => {
  const exerces = [...INTERDITS, ...INTERDITS_PAR_PREMIER_SEGMENT, ...INTERDITS_AUTRE_CASSE].map(
    (chemin) => chemin.toLowerCase(),
  );

  for (const repertoire of motifsDeLaSource('REPERTOIRES_INTERDITS')) {
    const bas = repertoire.toLowerCase();
    // `.git` n'est pas exerçable ici : `normaliser` le refuse avant la liste, et
    // c'est REFUSES_PAR_NORMALISER qui en répond.
    if (bas === '.git') continue;
    assert.ok(
      exerces.some((chemin) => chemin === bas || chemin.startsWith(`${bas}/`)),
      `le répertoire interdit « ${repertoire} » n'est exercé par aucun cas : ` +
        `l'ajouter à la liste sans l'ajouter au test le laisse sans filet`,
    );
  }

  for (const chemin of motifsDeLaSource('CHEMINS_INTERDITS')) {
    assert.ok(
      exerces.includes(chemin.toLowerCase()),
      `le chemin interdit « ${chemin} » n'est exercé par aucun cas`,
    );
  }

  for (const motif of motifsDeLaSource('NOMS_INTERDITS')) {
    const regex = motifVersRegex(motif);
    assert.ok(
      exerces.some((chemin) => regex.test(chemin.slice(chemin.lastIndexOf('/') + 1))),
      `le nom interdit « ${motif} » n'est exercé par aucun cas : c'est exactement le ` +
        `trou relevé sur Jenkinsfile, renovate.json et .github/actions/**`,
    );
  }
});
