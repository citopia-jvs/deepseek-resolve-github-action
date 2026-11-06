'use strict';

// Outils communs aux steps de l'action qui entourent claude-code-action :
// `preparer.js`, `verifier.js` et `conclure.js`.
// Bibliothèque standard uniquement, CommonJS : aucune dépendance.

const fs = require('node:fs');
const crypto = require('node:crypto');

const { git } = require('./git.js');
const { masquerSecrets } = require('./texte.js');

/** Valeur d'une variable d'environnement, trimée, '' si absente. */
function lireEnv(nom) {
  const valeur = process.env[nom];
  return typeof valeur === 'string' ? valeur.trim() : '';
}

function journaliser(message) {
  process.stdout.write(`${masquerSecrets(String(message))}\n`);
}

function avertir(message) {
  journaliser(`::warning::${String(message).replace(/\r?\n/g, ' ')}`);
}

/** Demande au runner de masquer une valeur dans la suite du journal. */
function masquer(valeur) {
  if (typeof valeur === 'string' && valeur !== '') process.stdout.write(`::add-mask::${valeur}\n`);
}

/**
 * Écrit des sorties de step, toujours sous la forme à délimiteur : une valeur
 * peut contenir des retours à la ligne (consigne, extrait de logs).
 * @param {Record<string, string>} sorties
 */
function ecrireSorties(sorties) {
  const fichier = process.env.GITHUB_OUTPUT;
  let bloc = '';
  for (const [nom, valeur] of Object.entries(sorties)) {
    const delimiteur = `FIN_${crypto.randomBytes(12).toString('hex')}`;
    bloc += `${nom}<<${delimiteur}\n${String(valeur)}\n${delimiteur}\n`;
  }
  if (fichier) fs.appendFileSync(fichier, bloc);
  else journaliser(`GITHUB_OUTPUT absente, sorties non écrites :\n${bloc}`);
}

/**
 * Se place dans le checkout du dépôt consommateur. Hors runner, reste dans le
 * répertoire courant.
 */
function entrerDansEspaceTravail() {
  const espace = lireEnv('GITHUB_WORKSPACE');
  if (espace !== '' && espace !== process.cwd()) process.chdir(espace);
  if (git(['rev-parse', '--is-inside-work-tree'], { tolererEchec: true }) !== 'true') {
    throw new Error(
      `${process.cwd()} n'est pas un dépôt git. L'action exige un actions/checkout avant elle.`,
    );
  }
}

/**
 * Arguments qui authentifient une commande git distante sans rien écrire sur le
 * disque : le jeton ne vit que dans la ligne de commande de cette commande.
 *
 * À placer avant `ls-remote`, `fetch` ET `push` : ne l'avoir mis que sur le push
 * a déjà tué un run réel (`could not read Username`).
 *
 * @param {string} jeton
 * @returns {ReadonlyArray<string>}
 */
function prefixeAuthentification(jeton) {
  if (jeton === '') return Object.freeze([]);
  const identifiants = Buffer.from(`x-access-token:${jeton}`, 'utf8').toString('base64');
  masquer(identifiants);
  return Object.freeze(['-c', `http.extraheader=AUTHORIZATION: basic ${identifiants}`]);
}

/**
 * Arguments qui empêchent git d'exécuter un hook du dépôt. Les tests lancés par
 * `verifier.js` exécutent du code écrit par le modèle, qui peut avoir déposé un
 * hook dans `.git/hooks` : sans ces arguments, git l'exécuterait au commit ou au
 * push, dans un step qui porte le jeton GitHub.
 */
const SANS_HOOKS = Object.freeze(['-c', 'core.hooksPath=/dev/null']);

/**
 * Remet `.git/config` dans l'état sauvegardé par `preparer.js`.
 *
 * Deux raisons. claude-code-action réécrit l'URL du remote avec le jeton dedans
 * (`https://x-access-token:<jeton>@…`) : sans restauration, ce jeton reste
 * lisible par les tests qui suivent. Et ces tests peuvent eux-mêmes modifier la
 * configuration (`core.fsmonitor`, `core.sshCommand`, alias…) pour faire
 * exécuter du code aux commandes git suivantes.
 *
 * @param {string} sauvegarde chemin de la copie faite par `preparer.js`
 */
function restaurerConfigurationGit(sauvegarde) {
  if (sauvegarde === '' || !fs.existsSync(sauvegarde)) {
    throw new Error(
      `Sauvegarde de .git/config introuvable (${JSON.stringify(sauvegarde)}) : ` +
        'la sortie « sauvegarde-config » de preparer.js est mal câblée.',
    );
  }
  const cheminConfig = git(['rev-parse', '--git-path', 'config']);
  fs.copyFileSync(sauvegarde, cheminConfig);
}

module.exports = {
  lireEnv,
  journaliser,
  avertir,
  masquer,
  ecrireSorties,
  entrerDansEspaceTravail,
  prefixeAuthentification,
  SANS_HOOKS,
  restaurerConfigurationGit,
};
