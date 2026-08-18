# Lot 3a — Préparation du checkout

**Dépend de** : lot 1. **Fichier** : `scripts/resolve.js`, partie amont. Les lots 3b
et 3c complètent le même fichier — ils ne sont donc pas parallélisables.
Lire [`contrat.md`](contrat.md).

## Objectif

Rendre le checkout du runner utilisable par aider : identité git, branche de travail,
masquage, et point de référence pour le comptage de commits.

## Risque R1 — sans identité git, aider plante

Vérifié dans `aider/repo.py` du wheel 0.86.2 :

```python
287            cmd += ["--"] + fnames
289            cmd += ["-a"]
291        original_user_name = self.repo.git.config("--get", "user.name")
296        try:
```

La ligne 291 est **hors** du `try` ouvert en 296. `git config --get` sur une clé
absente sort en code 1, ce qui fait lever à GitPython un `GitCommandError` non
rattrapé. Et `actions/checkout` ne configure ni `user.name` ni `user.email`.

Sans le `git config` de ce lot, le job plante au premier commit d'aider avec une trace
Python peu parlante. C'est le piège le plus coûteux du projet parce qu'il ne se voit
qu'à l'exécution réelle.

Reste vrai avec `--no-auto-commits` (décision 4) : aider passe encore par ce chemin
pour son commit d'arbre sale, et de toute façon l'action commite elle-même et a besoin
d'une identité.

## Séquence

### 1. Masquer

```
::add-mask::<valeur de DEEPSEEK_API_KEY>
::add-mask::<valeur de GH_TOKEN>
```

sur stdout. Deux nuances à connaître, parce que la version précédente de ce plan
surestimait cette mesure :

- Quand le consommateur passe `secrets.DEEPSEEK_API_KEY`, le runner masque **déjà** la
  valeur. L'appel ne sert qu'au consommateur qui passe la clé par `vars.` ou en clair.
- Le masquage ne vaut que pour ce qui est écrit **après**, et c'est de la cosmétique de
  journal : il remplace l'occurrence littérale exacte. Il ne voit ni un base64, ni un
  jeton coupé en deux, ni un `curl` sortant.

Le garder — une ligne, et il couvre le cas de la clé en clair. Ne pas le compter comme
une défense. Masquer aussi `GH_TOKEN`, ce que le plan précédent oubliait.

### 2. Configurer l'identité git (R1)

```
git config user.name  "deepseek-resolve[bot]"
git config user.email "deepseek-resolve@users.noreply.github.com"
```

Portée locale au dépôt, pas `--global` : on ne modifie pas l'environnement du runner
au-delà du job. La forme `nom[bot]` et l'adresse `@users.noreply.github.com` sont la
convention pour un auteur automatisé.

### 3. Résoudre la branche de base

`BRANCHE_BASE` peut être vide — c'est son défaut. La version précédente laissait la
question en suspens dans trois fichiers à la fois : le lot 4 disait « `''` → branche
par défaut », le lot 3a disait « la base est celle du checkout », et le lot 3c passait
`--base <base>` à `gh pr create`. Résolution explicite :

```
BRANCHE_BASE vide  → git rev-parse --abbrev-ref HEAD   (le checkout, qui est la
                     branche par défaut : un événement issues/issue_comment fait
                     toujours tourner le workflow sur celle-là)
sinon              → git fetch --depth=1 origin <base>
                     puis partir de origin/<base>
```

Le `--depth=1` compte : dans un dépôt shallow — `fetch-depth: 1` est le défaut de
`actions/checkout` — un `git fetch origin <base>` nu rapatrie tout l'historique de la
branche.

Vérifié : le `git fetch origin <base>` crée bien `refs/remotes/origin/<base>` grâce au
`remote.origin.fetch` posé par le checkout, donc `git switch -c … origin/<base>`
fonctionne.

### 4. Relever le SHA de base

`git rev-parse <la base résolue à l'étape 3>`, **pas** `git rev-parse HEAD`. Le lot 3c
compte `git rev-list --count <base>..HEAD` pour R4 ; avec un `base-branch` différent du
checkout, partir de `HEAD` donnerait un comptage faux.

Vérifié : ce comptage est exact dans un clone `--depth=1`.

### 5. Créer ou reprendre la branche — R9

```
si brancheDistanteExiste(BRANCHE) :
    git fetch --depth=1 origin BRANCHE:refs/remotes/origin/BRANCHE
    git switch -c BRANCHE origin/BRANCHE
sinon :
    git switch -c BRANCHE <base>
```

Le cas traité par la version précédente — « la branche existe **localement** » — est
impossible sur un runner neuf. Le cas réel est la branche restée **sur le remote**
après une PR fermée sans suppression, ou après un run annulé qui avait déjà poussé.
`git switch -c` réussissait alors localement, et le push du lot 3c était rejeté en
non-fast-forward — après avoir tout consommé.

Le nom vient de la sortie `branche` de la garde, qui **fait foi**. Ne pas le
reconstruire depuis `NUMERO_ISSUE` : la version précédente avait deux sources de vérité
pour le même nom. `NUMERO_ISSUE` ne sert qu'aux commentaires et au `Résout #<n>`.

### 6. Préparer l'authentification du push

Ne pas dépendre de `persist-credentials`. Construire une fois pour toutes le préfixe :

```
git -c http.extraheader="AUTHORIZATION: basic <base64 de x-access-token:$GH_TOKEN>" push …
```

Deux bénéfices : l'action fonctionne avec `persist-credentials: false`, que le lot 6
recommandera, et elle continue de fonctionner avec le défaut `true`.

Pourquoi ce changement de position — la version précédente écrivait « ne pas
désactiver `persist-credentials`, le push en dépend » : avec `true`, le jeton en
écriture est écrit dans `.git/config`, donc lisible par n'importe quel code exécuté
dans le checkout, y compris celui que le modèle vient d'écrire (R7). Un
`git credential fill` suffit. Recommander `persist-credentials: false` et authentifier
soi-même supprime ce chemin.

## Testabilité

Prévoir un drapeau `--preparer-seulement` (ou une variable équivalente) pour exercer
cette partie sans déclencher la boucle. C'est ce qui rend le lot vérifiable seul.

## Vérification

Sur un dépôt git jetable, sans réseau :

```bash
d=$(mktemp -d) && cd "$d" && git init -q .
git -c user.name=x -c user.email=x@y commit -q --allow-empty -m base

DEEPSEEK_API_KEY=sk-factice BRANCHE=fix-issue-42 NUMERO_ISSUE=42 BRANCHE_BASE= \
  node /chemin/vers/scripts/resolve.js --preparer-seulement

git config --get user.name      # deepseek-resolve[bot]
git branch --show-current       # fix-issue-42
```

Puis le cas R9 : créer un remote local jetable portant déjà `fix-issue-42`, relancer,
et vérifier que la branche est **reprise** et non recréée.
