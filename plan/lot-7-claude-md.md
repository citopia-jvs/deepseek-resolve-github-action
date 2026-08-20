# Lot 7 — Réécriture du `CLAUDE.md`

**Dépend de** : lot 4. Parallélisable avec le lot 6.

## Pourquoi ce lot existe

`CLAUDE.md` est chargé automatiquement dans le contexte de tout agent travaillant sur ce
dépôt. S'il décrit une architecture disparue, chaque session future part d'informations
fausses — et les croira, puisque c'est sa source d'autorité sur le projet. Un
`CLAUDE.md` périmé coûte plus cher qu'un `CLAUDE.md` absent.

À faire une fois les autres lots terminés, pour décrire ce qui est réellement en place.

## Ce qui devient faux et doit disparaître

| Section | Contenu périmé |
| --- | --- |
| **État actuel : incomplet, ne tourne pas** | Exports manquants de `github-client.js`, fichiers vides, absence de lockfile. Tout est supprimé au lot 0. |
| **Commandes** | `npm install` et les 4 dépendances : plus de `package.json`. La simulation par `INPUT_*` ne s'applique pas à une composite. |
| **Packaging de l'action** | La section entière — `using: node16`, bundling `ncc`, arbitrage « committer `node_modules` ou bundler ». Le composite supprime le sujet. |
| **Architecture** | Les trois couches par fichier, la boucle à deux prompts, `parseChanges` et son regex greedy. |
| **Contraintes structurantes** | Les quatre points. Tous résolus, pas contournés. |

## Ce qui reste vrai

La section **Langue** : code, commentaires, messages de commit, prompts adressés au
modèle et commentaires publiés sur les PR, tout en français. La conserver telle quelle —
et elle s'applique aux consignes passées à aider dans `resolve.js`.

## Structure visée

### Ce qu'est ce dépôt

Composite action GitHub qui pilote aider avec un modèle DeepSeek pour résoudre une issue.
Déclencheur `@dseek` dans une issue ou un commentaire, branche `fix-issue-<n>`, PR,
boucle bornée validation / correction.

Dire explicitement que **l'action n'implémente pas de boucle d'agent** : elle orchestre
aider. Un agent qui l'ignore risque de vouloir « compléter » une couche modèle qui n'a
pas à exister.

### Commandes

Ni dépendances, ni build, ni linter installé.

```bash
find scripts test -name '*.js' -print0 | xargs -0 -n1 node --check
for suite in test/*.test.js; do node "$suite"; done   # hors ligne, sans clé API
```

**Cinq corrections à ce bloc et à ce qui suit, mesurées aux lots 5 et 6.** Un
`CLAUDE.md` faux coûte plus cher qu'un `CLAUDE.md` absent — c'est l'argument même de ce
lot, il s'applique d'abord à lui :

1. la forme `-exec node --check {} \;` rend **0 même sur un script cassé** : un code non
   nul de l'utilitaire lancé par `-exec … ;` n'est pas une erreur pour `find`. `-exec … +`
   ne vaut pas mieux, `node --check bon.js casse.js` rendant 0. Seule la forme `xargs -0
   -n1` propage. Écrire l'ancienne apprendrait à un agent un contrôle qui ne peut pas
   échouer, et contredirait `.github/workflows/test.yml` ;
2. les suites sont **sept**, pas deux : `chemins`, `texte`, `garde`, `boucle`, `action`,
   `compte-rendu`, `ci`. Les lancer par un **glob** et non par une liste — une suite
   ajoutée est lancée sans que personne y pense, et une liste nommée dans `CLAUDE.md`
   sera périmée au lot suivant. Ne pas y porter de compte de cas, pour la même raison ;
3. `action.yml` a **cinq** steps, pas quatre : garde, `setup-python`, installation
   d'aider, résolution, compte rendu en `if: always()` ;
4. il n'y a plus de « job 1 » ni de « job 5 » dans la CI. Les jobs sont `syntaxe`,
   `suites`, `smoke-local` et `smoke-sous-repertoire`. Le contrôle de cohérence
   `inputs:` ↔ `${{ inputs.* }}` est livré par `test/action.test.js`, lancé par le job
   `suites` — pas par un contrôle Python, retiré au lot 4 parce qu'il était inexécutable
   et sortait en 0 sur une différence ;
5. le chemin relatif est attrapé par **`smoke-sous-repertoire`**, pas par le smoke local :
   en `uses: ./`, `GITHUB_ACTION_PATH` vaut `GITHUB_WORKSPACE`, donc un chemin relatif y
   passe. C'est toute la raison d'être du second job de smoke.

Préciser que `validation-command` (défaut `npm test`) s'applique au dépôt
**consommateur**, pas à celui-ci. C'est une confusion que l'ancien `CLAUDE.md` signalait
déjà et qui reste pertinente.

### Architecture

```
action.yml                # using: composite, 5 steps, 13 inputs, 5 outputs
aider.conf.yml            # config d'aider, maîtrisée par l'action
aider-models.json         # métadonnées des modèles DeepSeek V4
scripts/garde.js          # événement, autorisation, anti-rejeu — avant l'install d'aider
scripts/resolve.js        # préparation, primitives, orchestration
scripts/rendre-compte.js  # step if: always()
scripts/lib/              # gh, git, chemins, texte — stdlib seule
__fixtures__/             # payloads + stubs gh et aider
test/                     # sept suites, lancées par un glob
```

Contraintes à consigner, parce qu'elles ne se déduisent pas du code :

- **Stdlib Node uniquement**, CommonJS. Aucune dépendance, donc aucun bundling, donc pas
  de `dist/`. Invariant à préserver : ajouter une dépendance npm réintroduirait tout le
  problème de packaging que ce plan a supprimé.
- **Les inputs d'une composite ne sont pas exposés en `INPUT_*`** aux sous-processus.
  Toute valeur lue par un script doit figurer dans le `env:` de son step. C'est l'oubli
  le plus probable lors de l'ajout d'un input, et une faute de frappe dans
  `${{ inputs.* }}` s'évalue en chaîne vide **sans erreur**. `test/action.test.js` existe
  pour ça, et le job `suites` de la CI le lance.
- **`$GITHUB_ACTION_PATH`** pour atteindre les scripts embarqués — jamais un chemin
  relatif. Attention : sa valeur vaut `GITHUB_WORKSPACE` quand l'action est référencée en
  `uses: ./`, et `_actions/<owner>/<repo>/<ref>` sinon. Un chemin relatif passe donc la CI
  locale et casse chez le consommateur. C'est le job `smoke-sous-repertoire` de la CI qui
  l'attrape — pas `smoke-local`, où la variable vaut justement le workspace.
- **La garde tourne avant l'installation d'aider**, volontairement : `pipx install`
  installe 107 paquets et prend plus d'une minute.
- **Une composite action n'a ni `timeout-minutes`, ni `concurrency`, ni `pre:`/`post:`.**
  Le compte rendu en cas d'échec passe donc par un step `if: always()`, et la concurrence
  est prescrite au workflow consommateur.

### Pièges vérifiés

Ce sont des heures de débogage économisées ; aucun ne se devine à la lecture du code.
Tous relevés dans la source ou le wheel, avec la référence.

- **`aider-chat` est figé à `0.86.2` (2026-02-12)** et épingle `litellm==1.81.10`, dont la
  table de modèles ne contient **aucun** modèle DeepSeek V4. Le `model-metadata.json`
  d'aider ne connaît côté DeepSeek que `deepseek-chat` et `deepseek-reasoner`, **inaccessibles depuis le
  2026-07-24 15:59 UTC**. Il n'existe donc aucun modèle valide qu'aider connaisse d'un
  bloc : d'où `aider-models.json` embarqué et `--model-metadata-file`. Monter
  `aider-version` oblige à revérifier ce fichier.
- aider lit `git config user.name` **hors** de son bloc `try` (`repo.py:291` contre
  `:296`) : sans identité git configurée, il plante. `actions/checkout` ne la configure
  pas.
- **aider ne commite pas par `git commit -a`.** Les deux appelants passent une liste de
  fichiers (`base_coder.py:2383` et `:2419`), et la branche `cmd += ["-a"]` de
  `repo.py:289` est morte dans ce flux. Une version antérieure de ce projet croyait le
  contraire et en avait tiré une contre-mesure inutile. Le risque réel, plus étroit, est
  `--dirty-commits` (défaut `True`) sur un fichier que la validation a modifié et qu'aider
  édite ensuite. L'action tourne de toute façon en `--no-auto-commits` et commite
  elle-même.
- **`--config` est cherché dans le git root, `--env-file` vaut `.env` du git root,
  `--model-metadata-file` vaut `.aider.model.metadata.json`** — c'est-à-dire dans le
  checkout du consommateur, là où le modèle écrit. Un `.aider.conf.yml` créé à
  l'itération 1 est chargé à l'itération 2 et peut fixer `lint-cmd`, exécuté puisque
  `--auto-lint` vaut `True`. D'où les trois flags pointés sur des fichiers de l'action.
- Défauts de flags en 0.86.2, tous à `True` sauf le dernier : `--gitignore`,
  `--auto-commits`, `--dirty-commits`, `--auto-lint`, `--suggest-shell-commands`,
  `--show-model-warnings` ; `--git-commit-verify` à `False`. Ce dernier signifie qu'aider
  commite avec `--no-verify` : aucun hook `pre-commit` ne peut faire échouer son commit,
  et les linters du consommateur sont contournés.
- **`--yes-always` refuse les commandes shell suggérées par le modèle**
  (`base_coder.py:2459` passe `explicit_yes_required=True`, `io.py:866-867` renvoie
  `"n"`). Vraie protection, mais détail d'implémentation amont : `--no-suggest-shell-commands`
  est passé quand même.
- Le `GITHUB_TOKEN` n'a pas le droit `workflows` : toute écriture sous
  `.github/workflows/**` fait échouer le **push**, et le refus porte sur les commits
  poussés, pas sur l'état final de la branche. Restaurer le fichier après coup ne suffit
  donc pas — d'où le commit explicite sur liste de chemins.
- Une PR créée avec `GITHUB_TOKEN` démarre sa CI en état « approval required » pour
  `pull_request` `opened`/`synchronize`/`reopened`, et **ne déclenche rien du tout** pour
  les autres événements — une CI sur `on: push` ne part pas.
- **`author_association` n'est pas une permission** : `MEMBER` = membre de
  l'organisation, `COLLABORATOR` inclut `read` et `triage`. Et GitHub ne renvoie qu'une
  seule valeur, donc un membre ayant déjà commité est rapporté `CONTRIBUTOR`. La garde a
  donc deux étages, le second par
  `gh api repos/{o}/{r}/collaborators/{login}/permission`.
- **Ubuntu 26.04 embarque Python 3.14.4**, hors de la borne `<3.13` d'aider.
  `ubuntu-latest` y basculera : d'où `actions/setup-python` avec `3.12` et
  `ubuntu-24.04` en dur dans l'exemple du README.
- `pipx 1.16.6` est préinstallé sur les images Ubuntu — ne pas ajouter d'étape
  d'installation, et ne pas utiliser `curl … | sh`.
- `git status --porcelain` inclut les entrées `??`, et `git checkout -- <non-suivi>`
  échoue sur `pathspec did not match`. Utiliser `-z` et filtrer sur le statut.
- **La garde protège le déclencheur, pas la consigne.** Le corps de l'issue peut venir
  d'un tiers. Un bloc `<!-- … -->` est invisible dans le rendu GitHub. Ne pas écrire dans
  ce fichier que la garde suffit : la version précédente le faisait et cela clôturait la
  réflexion.

### Langue

Reprendre la section existante à l'identique.

## Vérification

Relire `CLAUDE.md` en se demandant, pour chaque affirmation : est-ce vrai du dépôt tel
qu'il est maintenant ? Vérifier qu'aucune phrase ne renvoie à `src/`, `package.json`,
`ncc`, `dist/`, `node16`, `deepseek-chat` ou `dry-run`.

Contrôle croisé avec le lot 6 : `CLAUDE.md` et `README.md` ne doivent pas se contredire
sur la liste des inputs, le modèle par défaut, ni la version d'aider.
