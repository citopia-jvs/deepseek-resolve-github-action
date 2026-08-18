# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Ce qu'est ce dépôt

GitHub Action JavaScript qui résout automatiquement des issues avec l'API DeepSeek.
Déclencheur : une issue ou un commentaire d'issue contenant `@dseek`. L'action crée
une branche `fix-issue-<n>`, ouvre une PR, puis boucle
réflexion → correction → commit → validation jusqu'à ce que la commande de
validation passe ou que `max-iterations` soit atteint.

## État actuel : incomplet, ne tourne pas

Avant toute modification fonctionnelle, savoir que :

- `src/github-client.js` exporte `addReaction`, `createBranch`, `createPR`,
  `commitChanges`, `commentOnPR` **qui n'existent pas** dans le fichier. Seules
  `listFiles` et `getFileContent` sont écrites. Le `require` d'`index.js` échoue
  donc au chargement.
- `src/iteration.js` et `src/utils.js` sont vides (0 octet). La boucle
  d'itération vit aujourd'hui dans `src/index.js` — c'est probablement là qu'elle
  doit être extraite.
- `.github/workflows/test.yml` est vide.
- Aucun `node_modules`, aucun lockfile, aucun `.gitignore`.

## Commandes

```bash
npm install          # installe les 4 dépendances (@actions/*, axios)
npm run build        # no-op actuellement (voir « Packaging » ci-dessous)
```

Il n'y a **pas de test runner ni de linter** configurés. `npm test` n'existe pas
dans ce dépôt — c'est pourtant la valeur par défaut de l'input
`validation-command`, mais celle-ci s'applique au dépôt *consommateur* de
l'action, pas à celui-ci.

Pour exercer l'action en local, simuler l'environnement Actions : variables
`INPUT_DEEPSEEK-API-KEY`, `INPUT_GITHUB-TOKEN`, `GITHUB_REPOSITORY`,
`GITHUB_EVENT_PATH` pointant vers un payload d'événement JSON, puis
`node src/index.js`.

## Packaging de l'action

`action.yml` déclare `using: node16` et `main: src/index.js` — sans étape de
bundling. Deux conséquences à traiter avant publication :

- `node16` est déprécié sur GitHub Actions ; viser `node20`.
- Le runtime ne fait pas de `npm install` : soit committer `node_modules`, soit
  bundler avec `@vercel/ncc` vers `dist/index.js` et faire pointer `main`
  dessus. La seconde option est la convention pour les actions JS.

## Architecture

Trois couches, une par fichier :

- `src/deepseek-client.js` — un seul appel HTTP (`axios`) vers
  `api.deepseek.com/v1/chat/completions`, modèle `deepseek-chat`,
  `temperature: 0.3`. Retourne le texte brut du message.
- `src/github-client.js` — toutes les interactions Octokit. `listFiles` lit
  l'arbre git en `recursive`, `getFileContent` décode le base64 de l'API
  contents. Les fonctions d'écriture (branche, PR, commit, commentaire,
  réaction) restent à écrire.
- `src/index.js` — orchestration : détection de l'événement, garde `@dseek`,
  garde « une PR existe déjà », création branche + PR, puis `runIterationLoop`.

### La boucle d'itération

Chaque tour enchaîne deux appels DeepSeek distincts :

1. **Réflexion** (`buildReflectionPrompt`) — analyse et plan, explicitement
   *sans code*. À partir de l'itération 2, les logs de la validation échouée
   sont injectés dans le prompt.
2. **Correction** (`buildCorrectionPrompt`) — reçoit la réflexion et exige un
   JSON pur `{ "chemin/fichier": "contenu complet du fichier" }`.

`parseChanges` extrait ce JSON avec `response.match(/\{[\s\S]*\}/)` — greedy, donc
fragile dès que la réponse contient du texte autour ou plusieurs blocs.
Un JSON absent ou invalide donne `{}`, ce qui fait sortir la boucle
immédiatement (« Aucune modification proposée »).

### Contraintes structurantes

- **Le contenu intégral de tous les fichiers du dépôt part dans chaque prompt**
  (`getRepoFiles` lit tout blob < 100 Ko, puis `buildReflectionPrompt` et
  `buildCorrectionPrompt` sérialisent l'ensemble). Sur un vrai dépôt, la fenêtre
  de contexte explose. Tout travail sérieux sur ce projet passe par une sélection
  de fichiers pertinents.
- **Deux univers de fichiers coexistent** : les commits passent par l'API GitHub
  (`commitChanges` sur `branchName`), mais la validation s'exécute via
  `@actions/exec` dans `process.cwd()`, c'est-à-dire le checkout du runner. Rien
  ne synchronise les deux : le code testé n'est pas le code que DeepSeek vient de
  commiter, sauf à faire un `git pull` ou à écrire les fichiers sur disque avant
  de valider.
- `execCommand` passe la commande à `exec(cmd, [], …)` sans arguments séparés :
  une `validation-command` du type `npm test -- --watch=false` ne sera pas
  découpée correctement.
- Dans `runIterationLoop`, le `catch` autour de la validation lit `err.stdout` /
  `err.stderr`, mais les variables `stdout`/`stderr` du bloc `try` restent
  toujours vides — les logs remontés à l'itération suivante sont donc partiels.

## Langue

Code, commentaires, messages de commit, prompts DeepSeek et commentaires publiés
sur les PR : tout est en français. S'y tenir.
