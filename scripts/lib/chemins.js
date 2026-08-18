'use strict';

// Normalisation des chemins et application de la liste de chemins interdits.
// Traite R3 (un workflow commité fait échouer le push) et R8 (la configuration
// d'aider est rechargée au tour suivant).
//
// Bibliothèque standard uniquement, CommonJS : aucune dépendance.

const fs = require('node:fs');
const path = require('node:path');

const NUL = String.fromCharCode(0);

// ---------------------------------------------------------------------------
// La liste interdite
//
// Elle est définie une seule fois, dans `plan/lot-3b-primitives.md` ; ce module
// ne fait que l'appliquer. Critère d'inscription : ce fichier est-il exécuté ou
// interprété automatiquement par quelque chose, sans relecture humaine ?
//
// Elle n'est pas exhaustive et ne peut pas l'être : un backdoor dans
// `src/index.js` reste un backdoor. C'est la relecture humaine qui protège.
// ---------------------------------------------------------------------------

// Motifs `répertoire/**` : le répertoire lui-même et tout ce qu'il contient.
const REPERTOIRES_INTERDITS = [
  '.github/workflows', // R3, et le GITHUB_TOKEN n'a pas le droit « workflows »
  '.github/actions', // modifier une action composite exécute du code dans TOUS les workflows du dépôt
  '.circleci',
  '.buildkite',
  '.husky',
  '.devcontainer',
  '.git',
];

// Chemins complets, ancrés à la racine du dépôt.
const CHEMINS_INTERDITS = [
  '.github/settings.yml',
  '.github/dependabot.yml',
];

// Noms de fichiers interdits, à N'IMPORTE QUELLE profondeur. Un `package.json`
// avec un `postinstall` ou un `conftest.py` imbriqué est aussi dangereux qu'à la
// racine — et `conftest.py` est justement un mécanisme par répertoire.
// `*` ne traverse pas `/`. La comparaison est insensible à la casse : un système
// de fichiers insensible à la casse rendrait sinon `PACKAGE.JSON` acceptable.
const NOMS_INTERDITS = [
  // actions
  'action.yml',
  'action.yaml',
  // CI hors GitHub
  '.gitlab-ci.yml',
  'Jenkinsfile',
  'azure-pipelines.yml',
  '.travis.yml',
  'bitbucket-pipelines.yml',
  '.drone.yml',
  // gouvernance
  // Nu, donc a toute profondeur : GitHub honore .github/, la racine et docs/.
  'CODEOWNERS',
  'renovate.json',
  // exécuté à l'install ou au test
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '.npmrc',
  '.yarnrc.yml',
  'requirements*.txt',
  'pyproject.toml',
  'setup.py',
  'conftest.py',
  'sitecustomize.py',
  'tox.ini',
  'noxfile.py',
  'Gemfile',
  'Makefile',
  'justfile',
  'Cargo.toml',
  'build.rs',
  'composer.json',
  // configuration de test = code
  'jest.config.*',
  'vitest.config.*',
  '.mocharc.*',
  'karma.conf.*',
  'playwright.config.*',
  // hooks
  '.pre-commit-config.yaml',
  // conteneurs
  'Dockerfile*',
  'docker-compose*.y*ml',
  'compose.yaml',
  'compose.yml',
  // aider — R8
  '.aider.conf.yml',
  '.aider.model.metadata.json',
  '.env',
  '.env.*',
];

const CARACTERES_REGEX = '\\^$.|?+()[]{}';

// Traduit un motif de nom de fichier en expression régulière. `**` couvre les
// séparateurs, `*` ne les franchit pas.
function versRegex(motif) {
  let source = '';
  for (let i = 0; i < motif.length; i += 1) {
    const c = motif[i];
    if (c === '*') {
      if (motif[i + 1] === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^/]*';
      }
    } else if (CARACTERES_REGEX.includes(c)) {
      source += `\\${c}`;
    } else {
      source += c;
    }
  }
  return new RegExp(`^${source}$`, 'i');
}

const REGEX_NOMS = NOMS_INTERDITS.map(versRegex);
const REPERTOIRES_MINUSCULES = REPERTOIRES_INTERDITS.map((r) => r.toLowerCase());
const CHEMINS_MINUSCULES = CHEMINS_INTERDITS.map((c) => c.toLowerCase());

/**
 * Ramène un chemin à sa forme POSIX relative, ou lève.
 *
 * Lever plutôt que renvoyer une valeur de repli : un chemin qu'on ne sait pas
 * normaliser ne doit pas être traité comme sûr.
 *
 * @param {string} chemin
 * @returns {string} chemin relatif normalisé, séparateurs `/`
 */
function normaliser(chemin) {
  if (typeof chemin !== 'string' || chemin === '') {
    throw new TypeError(`Chemin attendu non vide, reçu ${JSON.stringify(chemin)}`);
  }
  if (chemin.includes(NUL)) {
    throw new Error('Chemin contenant un octet nul, refusé');
  }
  if (path.posix.isAbsolute(chemin) || path.win32.isAbsolute(chemin)) {
    throw new Error(`Chemin absolu refusé : ${chemin}`);
  }

  let normalise = path.posix.normalize(chemin);
  while (normalise.length > 1 && normalise.endsWith('/')) {
    normalise = normalise.slice(0, -1);
  }

  if (normalise === '' || normalise === '.' || normalise === '/') {
    throw new Error(`Chemin vide après normalisation : ${chemin}`);
  }
  if (normalise.startsWith('/')) {
    throw new Error(`Chemin absolu refusé : ${chemin}`);
  }

  const segments = normalise.split('/');
  if (segments.includes('..')) {
    throw new Error(`Chemin remontant hors du dépôt refusé : ${chemin}`);
  }
  if (segments.some((s) => s.toLowerCase() === '.git')) {
    throw new Error(`Chemin sous .git/ refusé : ${chemin}`);
  }

  refuserLiens(segments);
  return normalise;
}

// Refuse un chemin dont un composant existant est un lien symbolique : écrire à
// travers un lien modifie une cible que la liste interdite n'a pas vue. Les
// chemins qui n'existent pas encore passent — c'est le cas d'un fichier créé.
function refuserLiens(segments) {
  let prefixe = '';
  for (const segment of segments) {
    prefixe = prefixe === '' ? segment : `${prefixe}/${segment}`;
    let etat;
    try {
      etat = fs.lstatSync(prefixe, { throwIfNoEntry: false });
    } catch {
      etat = undefined; // permission, chemin trop long : on ne conclut rien
    }
    if (etat && etat.isSymbolicLink()) {
      throw new Error(`Lien symbolique refusé dans le chemin : ${prefixe}`);
    }
  }
}

/**
 * Le chemin est-il dans la liste interdite ?
 *
 * Tout chemin que `normaliser` refuse est considéré interdit : un chemin qu'on
 * ne sait pas juger ne doit pas être écrit.
 *
 * Impure : `normaliser` fait des `lstat` pour refuser les liens symboliques, donc
 * les chemins relatifs sont résolus depuis le répertoire courant. À appeler depuis
 * `GITHUB_WORKSPACE` (cf. `contrat.md`).
 *
 * @param {string} chemin
 * @returns {boolean}
 */
function estCheminInterdit(chemin) {
  let normalise;
  try {
    normalise = normaliser(chemin);
  } catch {
    return true;
  }

  const bas = normalise.toLowerCase();

  for (const repertoire of REPERTOIRES_MINUSCULES) {
    if (bas === repertoire || bas.startsWith(`${repertoire}/`)) return true;
  }
  if (CHEMINS_MINUSCULES.includes(bas)) return true;

  const nom = bas.slice(bas.lastIndexOf('/') + 1);
  return REGEX_NOMS.some((regex) => regex.test(nom));
}

module.exports = { normaliser, estCheminInterdit };
