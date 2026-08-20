# Lot 0 — Ménage

**Dépend de** : rien. Parallélisable avec le lot 1.

## Objectif

Supprimer la boucle d'agent maison, qui est remplacée par aider, et ajouter le
`.gitignore` absent du dépôt.

## Contexte

Le dépôt est une GitHub Action JavaScript inachevée : `src/github-client.js` exporte
cinq fonctions qui n'existent pas dans le fichier, `src/iteration.js` et
`src/utils.js` sont vides (0 octet). La décision est prise de remplacer toute cette
couche par un pilotage d'aider depuis une *composite action*. Il ne reste donc rien
à sauver dans `src/`, et les quatre dépendances npm deviennent inutiles.

Travailler sur la branche `feat/composite-aider`, pas sur `main` : entre ce lot et le
lot 4, l'action est inutilisable. Aucun tag n'existe, donc personne ne consomme le
dépôt, mais la CI du lot 5 doit pouvoir tourner sur une PR.

## Fichiers à supprimer

```
src/index.js
src/deepseek-client.js
src/github-client.js
src/iteration.js
src/utils.js
package.json
```

Le répertoire `src/` doit disparaître (il sera vide).

`package.json` ne déclarait que `@actions/core`, `@actions/github`, `@actions/exec`
et `axios` — toutes abandonnées — plus un `build` qui était un `echo`. Une composite
action n'a pas besoin de `package.json` : les scripts n'utiliseront que la
bibliothèque standard de Node et la CLI `gh`.

**Ne pas toucher** à `action.yml` (lot 4), `README.md` (lot 6), `CLAUDE.md` (lot 7),
`.github/workflows/test.yml` (lot 5), au dossier `plan/`, ni à `PLAN-A.md` (plan
abandonné, laissé en place).

## Fichier à créer

`.gitignore` :

```gitignore
node_modules/
.aider*
*.log
```

Ce `.gitignore` protège **ce** dépôt-ci, celui de l'action : il évite qu'un fichier
de travail d'aider ou un `node_modules` atterrisse dans un commit pendant le
développement. Il n'a aucun effet sur les PR produites chez un consommateur — c'est
`--no-gitignore` et la liste de chemins interdits du lot 3b qui s'en chargent. Ne pas
confondre les deux dépôts, la version précédente de ce plan le faisait.

## Vérification

```bash
test ! -e src
test ! -e package.json
git status --porcelain -- src package.json .gitignore
```

Restreindre le `git status` à ces trois chemins : le dépôt contient par ailleurs
`PLAN-A.md` et `plan/` non suivis, qui apparaîtraient dans un `git status` nu et
brouilleraient le contrôle.
