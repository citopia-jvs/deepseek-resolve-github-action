const core = require('@actions/core');
const github = require('@actions/github');
const { exec } = require('@actions/exec');
const fs = require('fs').promises;
const path = require('path');
const { createBranch, createPR, addReaction, commentOnPR, commitChanges, getFileContent, listFiles } = require('./github-client');
const { askDeepSeek } = require('./deepseek-client');

async function run() {
  try {
    const apiKey = core.getInput('deepseek-api-key', { required: true });
    const maxIterations = parseInt(core.getInput('max-iterations') || '2');
    const validationCmd = core.getInput('validation-command') || 'npm test';
    const baseBranch = core.getInput('base-branch') || github.context.payload.repository.default_branch;
    const token = core.getInput('github-token');

    const octokit = github.getOctokit(token);
    const context = github.context;
    const { owner, repo } = context.repo;

    // Déterminer l'événement
    let issueNumber;
    let commentId = null;
    let bodyText = '';

    if (context.payload.issue) {
      issueNumber = context.payload.issue.number;
      bodyText = context.payload.issue.body || '';
    } else if (context.payload.comment) {
      issueNumber = context.payload.issue.number;
      commentId = context.payload.comment.id;
      bodyText = context.payload.comment.body || '';
    } else {
      core.setFailed('Événement non supporté');
      return;
    }

    if (!bodyText.toLowerCase().includes('@dseek')) {
      core.info('@dseek non trouvé, sortie');
      return;
    }

    // Accuser réception
    if (commentId) {
      await addReaction(octokit, owner, repo, commentId, 'eyes');
    } else {
      await addReaction(octokit, owner, repo, issueNumber, 'eyes');
    }

    // Récupérer les détails de l'issue
    const issue = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
    const issueTitle = issue.data.title;
    const issueBody = issue.data.body || '';

    // Vérifier si une PR existe déjà
    const branchName = `fix-issue-${issueNumber}`;
    const { data: existingPRs } = await octokit.rest.pulls.list({
      owner, repo, state: 'open', head: branchName
    });
    if (existingPRs.length > 0) {
      core.info(`Une PR existe déjà pour l'issue #${issueNumber}, on ne recrée pas.`);
      return;
    }

    // Créer la branche
    await createBranch(octokit, owner, repo, branchName, baseBranch);

    // Créer la PR
    const prTitle = `Résolution de l'issue #${issueNumber} : ${issueTitle}`;
    const prBody = `
## Résolution automatique de l'issue #${issueNumber}

### Contexte
${issueBody}

### Objectifs à atteindre
- [ ] Comprendre le problème
- [ ] Proposer une solution
- [ ] Implémenter et tester
- [ ] Valider avec \`${validationCmd}\`

Cette PR a été créée automatiquement par l'action DeepSeek.
    `;
    const pr = await createPR(octokit, owner, repo, prTitle, prBody, branchName, baseBranch);
    const prNumber = pr.data.number;

    // ---- BOUCLE D'ITÉRATION AMÉLIORÉE ----
    const result = await runIterationLoop({
      octokit,
      owner,
      repo,
      issueNumber,
      issueTitle,
      issueBody,
      branchName,
      prNumber,
      apiKey,
      maxIterations,
      validationCmd
    });

    // Commentaire final
    let finalComment;
    if (result.success) {
      finalComment = `🎉 **Succès !** L'issue #${issueNumber} a été résolue en ${result.iteration} itération(s). La PR est prête pour révision.`;
    } else {
      finalComment = `❌ **Échec** après ${maxIterations} itérations. Cause : ${result.errorMessage || 'Validation non passée.'}`;
    }
    await commentOnPR(octokit, owner, repo, prNumber, finalComment);

  } catch (error) {
    core.setFailed(error.message);
  }
}

// ------------------------------------------------------------------
// Fonction principale de la boucle
// ------------------------------------------------------------------
async function runIterationLoop(params) {
  const {
    octokit, owner, repo, issueNumber, issueTitle, issueBody,
    branchName, prNumber, apiKey, maxIterations, validationCmd
  } = params;

  let iteration = 0;
  let success = false;
  let errorMessage = '';
  let validationOutput = ''; // logs des derniers tests

  // Récupérer les fichiers du repo (on filtre les extensions courantes)
  let files = await getRepoFiles(octokit, owner, repo, branchName);

  while (iteration < maxIterations && !success) {
    iteration++;
    core.info(`Itération ${iteration}/${maxIterations}`);

    try {
      // 1. Réflexion
      const reflectionPrompt = buildReflectionPrompt(issueTitle, issueBody, files, validationOutput, iteration);
      const reflection = await askDeepSeek(apiKey, reflectionPrompt);
      core.debug(`Réflexion: ${reflection}`);

      // 2. Correction
      const correctionPrompt = buildCorrectionPrompt(issueTitle, issueBody, files, reflection, validationOutput);
      const correctionResponse = await askDeepSeek(apiKey, correctionPrompt);
      core.debug(`Correction: ${correctionResponse}`);

      // 3. Appliquer les modifications
      const changes = parseChanges(correctionResponse);
      if (Object.keys(changes).length === 0) {
        throw new Error('Aucune modification proposée par DeepSeek');
      }
      await commitChanges(octokit, owner, repo, branchName, changes, `Iteration ${iteration} - modifications DeepSeek`);

      // 4. Validation locale (on suppose que le repo est checkouté dans le répertoire courant)
      let validationSuccess = false;
      let stdout = '', stderr = '';
      try {
        // On exécute la commande dans le répertoire du repo (process.cwd())
        const exitCode = await execCommand(validationCmd);
        validationSuccess = (exitCode === 0);
        // On peut aussi capturer stdout/stderr avec un buffer
        // Pour simplifier, on utilise exec avec un callback, mais on va utiliser la méthode promisify
        // On utilise exec directement plus bas
      } catch (err) {
        validationSuccess = false;
        stdout = err.stdout || '';
        stderr = err.stderr || '';
      }

      // On prépare le feedback pour la prochaine itération
      if (validationSuccess) {
        validationOutput = `Validation réussie à l'itération ${iteration}.`;
        success = true;
        await commentOnPR(octokit, owner, repo, prNumber, `✅ Itération ${iteration} validée avec succès !`);
      } else {
        validationOutput = `Validation échouée à l'itération ${iteration}.\nStdout: ${stdout}\nStderr: ${stderr}`;
        core.warning(validationOutput);
        await commentOnPR(octokit, owner, repo, prNumber, `❌ Itération ${iteration} : validation échouée. Je vais tenter de corriger.`);
        // Mettre à jour la liste des fichiers après les changements
        files = await getRepoFiles(octokit, owner, repo, branchName);
        errorMessage = validationOutput;
      }
    } catch (err) {
      errorMessage = `Erreur à l'itération ${iteration} : ${err.message}`;
      core.warning(errorMessage);
      // Si DeepSeek n'a pas proposé de modifications, on arrête
      if (err.message.includes('Aucune modification')) {
        break;
      }
      // Sinon on continue (on réessaye)
    }
  }

  return { success, iteration, errorMessage };
}

// ------------------------------------------------------------------
// Fonctions utilitaires
// ------------------------------------------------------------------

// Récupère la liste des fichiers avec leur contenu sur la branche donnée
async function getRepoFiles(octokit, owner, repo, branch) {
  const fileList = await listFiles(octokit, owner, repo, branch);
  const files = {};
  for (const file of fileList) {
    // On ignore les dossiers et les fichiers trop gros ou binaires
    if (file.type === 'blob' && file.size < 100000) { // < 100KB
      try {
        const content = await getFileContent(octokit, owner, repo, file.path, branch);
        files[file.path] = content;
      } catch (e) {
        core.warning(`Impossible de lire ${file.path}: ${e.message}`);
      }
    }
  }
  return files;
}

// Construit le prompt de réflexion
function buildReflectionPrompt(title, body, files, validationLog, iteration) {
  const fileSummary = Object.keys(files).map(p => `- ${p}`).join('\n');
  let feedback = '';
  if (iteration > 1) {
    feedback = `\nLa validation précédente a échoué avec ces logs :\n${validationLog}\n`;
  }
  return `
Tu es un développeur expert. Voici l'issue à résoudre :
Titre : ${title}
Description : ${body}

Voici les fichiers actuels du projet (liste simplifiée avec contenu) :
${Object.entries(files).map(([path, content]) => `### ${path}\n${content}\n`).join('\n')}

${feedback}

Fais une **réflexion** : analyse le problème, identifie les causes, et propose un plan pour le résoudre.
Ne donne pas encore le code, juste une explication de ta stratégie.
  `;
}

// Construit le prompt de correction
function buildCorrectionPrompt(title, body, files, reflection, validationLog) {
  const fileSummary = Object.keys(files).map(p => `- ${p}`).join('\n');
  return `
En te basant sur ta réflexion précédente :
${reflection}

Propose maintenant les modifications concrètes sous forme d'un objet JSON où les clés sont les chemins des fichiers et les valeurs sont le nouveau contenu complet du fichier.
Seul le JSON est attendu, sans autre texte.

Exemple de format :
{
  "src/index.js": "contenu modifié",
  "README.md": "contenu modifié"
}

N'oublie pas de prendre en compte les logs d'erreur précédents :
${validationLog}

Voici les fichiers actuels :
${Object.entries(files).map(([path, content]) => `### ${path}\n${content}\n`).join('\n')}

Réponds uniquement avec le JSON.
  `;
}

// Parse la réponse de DeepSeek pour en extraire les modifications
function parseChanges(response) {
  try {
    // On essaie de trouver un bloc JSON dans la réponse
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return {};
  } catch (e) {
    core.warning(`Impossible de parser la réponse: ${e.message}`);
    return {};
  }
}

// Exécute une commande shell et retourne le code de sortie (0 = succès)
async function execCommand(cmd) {
  let stdout = '';
  let stderr = '';
  const exitCode = await exec(cmd, [], {
    listeners: {
      stdout: (data) => { stdout += data.toString(); },
      stderr: (data) => { stderr += data.toString(); }
    },
    cwd: process.cwd() // le repo est supposé checkouté ici
  });
  // Si exitCode !== 0, on lance une erreur avec stdout/stderr
  if (exitCode !== 0) {
    const err = new Error(`Commande échouée avec code ${exitCode}`);
    err.stdout = stdout;
    err.stderr = stderr;
    throw err;
  }
  return exitCode;
}

run();