'use strict';

// Wrapper autour de la CLI `gh`, présente sur les runners GitHub.
// Bibliothèque standard uniquement, CommonJS : aucune dépendance.

const { spawnSync } = require('node:child_process');
const { masquerSecrets, tronquer } = require('./texte.js');

// Binaire injectable : c'est ce qui rend les lots testables hors ligne.
// Ne jamais coder « gh » en dur ailleurs que dans ce repli.
function binaire() {
  return process.env.GH_CLI || 'gh';
}

// 32 Mio : une sortie `gh api` paginée dépasse largement le défaut de 1 Mio.
const TAILLE_MAX_SORTIE = 32 * 1024 * 1024;

/**
 * Lance `gh` avec un tableau d'arguments.
 *
 * L'appelant ajoute lui-même `--repo <GITHUB_REPOSITORY>` sur les commandes qui
 * visent un dépôt : sans lui, `gh` résout le dépôt par le remote du répertoire
 * courant — ce qui marche par effet de bord en production et interroge le mauvais
 * dépôt en test. Attention, `gh` lit `GH_REPO`, pas `GITHUB_REPOSITORY`.
 *
 * @param {string[]} args arguments passés tels quels, jamais concaténés dans un shell
 * @param {{ json?: boolean, tolererEchec?: boolean }} [options]
 *   `json` : parse stdout en JSON.
 *   `tolererEchec` : renvoie `null` au lieu de lever. Deux usages réels : la
 *   réaction 👀 (accessoire) et le contrôle de permission, qui répond 404 pour un
 *   non-collaborateur — une réponse, pas une panne.
 * @returns {string|object|null} stdout trimmé, valeur JSON, ou `null` si toléré
 */
function gh(args, { json = false, tolererEchec = false } = {}) {
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw new TypeError('gh() attend un tableau de chaînes en premier argument');
  }

  const bin = binaire();
  // Jamais `shell: true` : les arguments viennent de payloads d'événement, donc
  // de texte rédigé par un tiers. Le tableau ferme l'injection de commande.
  // `encoding: 'utf8'`, sinon stdout est un Buffer.
  const resultat = spawnSync(bin, args, {
    encoding: 'utf8',
    maxBuffer: TAILLE_MAX_SORTIE,
  });

  // Le libellé de commande part dans les logs du job : il peut contenir un jeton
  // passé en argument, d'où le masquage systématique.
  const commande = masquerSecrets([bin, ...args].join(' '));
  const stderr = masquerSecrets(String(resultat.stderr || '').trim());

  // Échec de lancement (binaire absent, processus tué) : `error` est peuplé et
  // `status` vaut `null`. Sans ce cas explicite, un `gh` manquant produit un
  // message incompréhensible.
  //
  // Ce cas lève TOUJOURS, `tolererEchec` compris : un `GH_CLI` mal positionné en
  // CI ne doit pas être indiscernable d'un 404 du serveur. `tolererEchec` ne
  // couvre qu'un code de sortie non nul, c'est-à-dire une réponse.
  if (resultat.error || resultat.status === null) {
    const cause = resultat.error
      ? masquerSecrets(resultat.error.message)
      : `interrompu par le signal ${resultat.signal}`;
    throw new Error(`Lancement de « ${commande} » impossible : ${cause}`);
  }

  if (resultat.status !== 0) {
    if (tolererEchec) return null;
    throw new Error(
      `« ${commande} » a échoué (code ${resultat.status})` +
        (stderr ? `\n${tronquer(stderr, 4000)}` : ''),
    );
  }

  // stdout n'est PAS masqué : c'est une donnée de travail, pas un texte publié.
  // Masquer ici casserait un JSON contenant un blob base64 légitime. Le masquage
  // est la responsabilité de ce qui publie (lot 3b).
  const sortie = String(resultat.stdout || '').trim();
  if (!json) return sortie;

  // Un stdout vide donnerait une SyntaxError opaque sur JSON.parse('') — c'est
  // exactement ce qui arrive avec un stub mal écrit.
  if (sortie === '') {
    throw new Error(
      `« ${commande} » n'a rien écrit sur stdout alors qu'une réponse JSON était attendue`,
    );
  }
  try {
    return JSON.parse(sortie);
  } catch (err) {
    throw new Error(
      `« ${commande} » n'a pas répondu du JSON valide : ${err.message}\n` +
        tronquer(sortie, 1000),
    );
  }
}

module.exports = { gh };
