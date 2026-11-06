#!/usr/bin/env node
'use strict';

// Step « conclure » : dernier step, en `if: always()` dès que la pull request
// brouillon existe.
//
//   1. commite le travail du modèle, sur une liste explicite de chemins
//      autorisés, et refuse le commit si le jeton GitHub y apparaît ;
//   2. pousse sur la branche de la pull request ;
//   3. tests verts : passe la PR en « prête » et demande la revue ;
//      sinon : la laisse en brouillon et explique pourquoi.
//
// Bibliothèque standard uniquement, CommonJS : aucune dépendance.

const fs = require('node:fs');

const { git, etatFichiers } = require('./lib/git.js');
const { gh } = require('./lib/gh.js');
const { estCheminInterdit, normaliser } = require('./lib/chemins.js');
const { masquerSecrets, nettoyerTexteTiers, tronquer } = require('./lib/texte.js');
const {
  lireEnv,
  journaliser,
  avertir,
  masquer,
  ecrireSorties,
  entrerDansEspaceTravail,
  prefixeAuthentification,
  SANS_HOOKS,
  restaurerConfigurationGit,
} = require('./lib/action.js');

const LOGIN_VALIDE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const LONGUEUR_MAX_REPONSE = 3000;

function lireConfiguration() {
  const numeroPr = Number(lireEnv('NUMERO_PR'));
  if (!Number.isInteger(numeroPr) || numeroPr <= 0) {
    throw new Error(`NUMERO_PR invalide : ${JSON.stringify(lireEnv('NUMERO_PR'))}.`);
  }
  return Object.freeze({
    numeroPr,
    numeroIssue: lireEnv('NUMERO_ISSUE'),
    branche: lireEnv('BRANCHE'),
    depot: lireEnv('GITHUB_REPOSITORY'),
    jetonGh: lireEnv('GH_TOKEN'),
    sauvegarde: lireEnv('SAUVEGARDE_CONFIG'),
    succes: lireEnv('SUCCES') === 'true',
    passages: lireEnv('PASSAGES') || '1',
    issueClaude: lireEnv('ISSUE_CLAUDE'),
    extrait: process.env.EXTRAIT || '',
    relecteur: lireEnv('RELECTEUR'),
    fichierExecution: lireEnv('FICHIER_EXECUTION'),
  });
}

/**
 * Sépare les chemins modifiés en autorisés et refusés. Les deux côtés d'un
 * renommage vont ensemble : en commiter la moitié laisserait un dépôt incohérent.
 */
function trierChemins() {
  const entrees = etatFichiers();
  const autorises = [];
  const refuses = [];
  for (let i = 0; i < entrees.length; i += 1) {
    const groupe = [entrees[i]];
    if (entrees[i + 1] && entrees[i + 1].statut === 'R<') {
      groupe.push(entrees[i + 1]);
      i += 1;
    }
    const chemins = [];
    let refuse = false;
    for (const entree of groupe) {
      // Jugé sur le chemin BRUT : un dépôt imbriqué est rendu « imbrique/ », et
      // la normalisation retirerait le « / » que `estCheminInterdit` refuse.
      if (estCheminInterdit(entree.chemin)) refuse = true;
      try {
        chemins.push(normaliser(entree.chemin));
      } catch {
        refuse = true;
        chemins.push(entree.chemin);
      }
    }
    (refuse ? refuses : autorises).push(...chemins);
  }
  return { autorises, refuses };
}

/** Le jeton, ou sa forme d'en-tête HTTP, apparaît-il dans ce qui va être commité ? */
function contientLeJeton(jeton) {
  if (jeton === '') return false;
  const diff = git(['diff', '--cached', '--no-color', '--text']) || '';
  const enTete = Buffer.from(`x-access-token:${jeton}`, 'utf8').toString('base64');
  return diff.includes(jeton) || diff.includes(enTete);
}

/** @returns {{ commite: boolean, refuses: string[], motif: string }} */
function commiter(config) {
  git(['reset', '--quiet'], { tolererEchec: true });
  const { autorises, refuses } = trierChemins();
  for (const chemin of refuses) avertir(`Chemin refusé, non commité : ${chemin}`);
  if (autorises.length === 0) return { commite: false, refuses, motif: 'aucune modification autorisée' };

  for (let i = 0; i < autorises.length; i += 200) {
    git(['add', '--all', '--', ...autorises.slice(i, i + 200)]);
  }
  if (git(['diff', '--cached', '--quiet'], { tolererEchec: true }) !== null) {
    return { commite: false, refuses, motif: 'aucune modification' };
  }
  if (contientLeJeton(config.jetonGh)) {
    git(['reset', '--quiet'], { tolererEchec: true });
    return { commite: false, refuses, motif: 'le jeton GitHub apparaît dans les fichiers modifiés' };
  }
  git([...SANS_HOOKS, 'commit', '--no-verify', '--quiet', '-m',
    `fix: résoudre l'issue #${config.numeroIssue}\n\nModifications proposées par le modèle, ` +
      `${config.succes ? 'validées' : 'NON validées'} par la commande de validation.`]);
  return { commite: true, refuses, motif: '' };
}

/**
 * Dernière réponse du modèle, lue dans le journal de session de
 * claude-code-action. En mode agent, l'action ne la publie nulle part : sans
 * elle, une explication comme « il faut modifier package.json à la main » se
 * perdrait. Texte du modèle, donc nettoyé, masqué et borné avant publication.
 */
function reponseDuModele(config) {
  if (config.fichierExecution === '') return '';
  try {
    const messages = JSON.parse(fs.readFileSync(config.fichierExecution, 'utf8'));
    const fin = Array.isArray(messages) ? messages.filter((m) => m && m.type === 'result').pop() : null;
    let texte = fin && typeof fin.result === 'string' ? fin.result : '';
    if (config.jetonGh !== '') texte = texte.split(config.jetonGh).join('***');
    return tronquer(masquerSecrets(nettoyerTexteTiers(texte)).trim(), LONGUEUR_MAX_REPONSE);
  } catch (err) {
    avertir(`Journal de session illisible : ${err && err.message ? err.message : err}`);
    return '';
  }
}

function commenter(config, lignes) {
  gh(['pr', 'comment', String(config.numeroPr), '--repo', config.depot, '--body', lignes.join('\n')],
    { tolererEchec: true });
}

function principal() {
  const config = lireConfiguration();
  masquer(config.jetonGh);
  entrerDansEspaceTravail();
  restaurerConfigurationGit(config.sauvegarde);

  const resultat = commiter(config);
  if (resultat.commite) {
    git([...prefixeAuthentification(config.jetonGh), ...SANS_HOOKS, 'push', '--quiet', 'origin',
      `HEAD:refs/heads/${config.branche}`]);
    journaliser(`Travail poussé sur ${config.branche}.`);
  } else {
    journaliser(`Rien de commité : ${resultat.motif}.`);
  }

  const lignes = [];
  if (resultat.refuses.length > 0) {
    lignes.push(
      "Chemins modifiés par le modèle mais **non commités**, parce que l'action ne les écrit pas :",
      ...resultat.refuses.map((c) => `- \`${c.replace(/`/g, "'")}\``),
      '',
    );
  }

  const succes = config.succes && resultat.commite;
  if (succes) {
    gh(['pr', 'ready', String(config.numeroPr), '--repo', config.depot]);
    let revue = '';
    if (LOGIN_VALIDE.test(config.relecteur)) {
      const demandee = gh(['pr', 'edit', String(config.numeroPr), '--repo', config.depot,
        '--add-reviewer', config.relecteur], { tolererEchec: true });
      revue = demandee === null
        ? ` La demande de revue à @${config.relecteur} a échoué.`
        : ` Revue demandée à @${config.relecteur}.`;
    }
    lignes.unshift(`Validation réussie après ${config.passages} passage(s) du modèle. Pull request prête.${revue}`, '');
  } else {
    let motif;
    if (!resultat.commite && resultat.motif !== 'aucune modification autorisée' && resultat.motif !== 'aucune modification') {
      motif = `Rien n'a été commité : ${resultat.motif}.`;
    } else if (!resultat.commite) {
      motif = config.issueClaude === 'success'
        ? "Le modèle n'a produit aucune modification commitable."
        : `Le passage du modèle s'est terminé en « ${config.issueClaude || 'inconnu'} » sans modification commitable.`;
    } else {
      motif = `La validation échoue encore après ${config.passages} passage(s) du modèle.`;
    }
    lignes.unshift(`${motif} La pull request reste en brouillon.`, '');
    if (config.extrait.trim() !== '') {
      lignes.push('<details><summary>Fin de la sortie de la validation</summary>', '', '````text',
        config.extrait.replace(/````/g, '```'), '````', '', '</details>');
    }
  }
  const reponse = reponseDuModele(config);
  if (reponse !== '') {
    lignes.push('', '<details><summary>Dernière réponse du modèle</summary>', '', reponse, '', '</details>');
  }
  commenter(config, lignes);
  ecrireSorties({ succes: succes ? 'true' : 'false' });
}

try {
  principal();
} catch (err) {
  process.stdout.write(`::error::${String(err && err.message ? err.message : err).replace(/\r?\n/g, ' ')}\n`);
  process.exit(1);
}
