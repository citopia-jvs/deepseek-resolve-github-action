# Lot 5 — Intégration continue

**Dépend de** : lots 2, 3c et 4.
**Fichier** : `.github/workflows/test.yml`, aujourd'hui vide (0 octet).

## Objectif

Vérifier l'action à chaque PR, **sans clé API DeepSeek** et sans réseau vers l'API. Ce
qui est testable gratuitement doit l'être — et grâce au stub `AIDER_CLI` du lot 1, cela
inclut maintenant la boucle, ce qui n'était pas le cas dans la version précédente du
plan.

## Déclencheurs

```yaml
on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read
```

`permissions: contents: read` au niveau du workflow : aucun de ces jobs n'a besoin
d'écrire, et le défaut du dépôt est peut-être plus permissif.

Tous les jobs sur `runs-on: ubuntu-24.04`, pas `ubuntu-latest` : le smoke test doit
tourner sur la même image que celle recommandée aux consommateurs (R11).

## Job 1 — Syntaxe et workflows

```yaml
- run: find scripts test -name '*.js' -exec node --check {} \;
- uses: rhysd/actionlint@…      # ou le binaire
```

`node --check` sur tous les scripts : trivial, mais attrape la faute de frappe qui
ferait planter le job dans le dépôt d'un consommateur.

`actionlint` sur `.github/workflows/**` : la version précédente de ce plan avait raison
de dire qu'il ne valide pas `action.yml`, mais elle en avait conclu qu'il fallait
abandonner l'outil. Il reste utile sur ce fichier-ci et sur l'exemple copiable du lot 6.

Ajouter le contrôle de cohérence `inputs:` ↔ `${{ inputs.* }}` décrit au lot 4. Une
faute de frappe dans un nom d'input s'évalue en chaîne vide sans erreur : aucun autre
contrôle ne l'attrape.

## Job 2 — La garde

`node test/garde.test.js`, livré par le lot 2 avec ses dix fixtures.

Le harnais contient aussi des cas qui **n'ajoutent pas de fixture** : ils réutilisent un
payload existant avec un scénario du stub `gh`. C'est nécessaire, pas décoratif — les
garde-fous fail-closed de l'étage 2 dépendent de la *réponse* de l'API, pas du payload,
et on peut donc les retirer sans faire rougir un seul cas piloté par fixture. Vérifié en
relecture du lot 2.

| Fixture | `poursuivre` |
| --- | --- |
| `issue-avec-dseek.json` | `true` |
| `commentaire-avec-dseek.json` | `true` |
| `issue-auteur-non-de-confiance.json` | `true` (mode consigne restreinte) |
| `issue-sans-dseek.json` | `false` |
| `commentaire-sur-pr.json` | `false` |
| `commentaire-non-autorise.json` | `false` |
| `commentaire-reedite.json` | `false` |
| `evenement-push.json` | `false` |
| `issue-mention-cachee.json` | `false` |
| `commentaire-reedite-mention-cachee.json` | `false` |

Contrôler **deux choses** par cas : la valeur de `poursuivre`, et que le code de sortie
vaut **0 partout**, y compris les refus. Un refus n'est pas une panne, et une action qui
échoue en rouge à chaque commentaire anodin serait inutilisable.

`GH_CLI=__fixtures__/gh-stub.sh` — le stub versionné, qui écrit `[]`. Pas `/bin/true` :
stdout serait vide et `JSON.parse('')` lèverait.

## Job 3 — La boucle, hors ligne

**Nouveau.** C'est ce que le stub `AIDER_CLI` du lot 1 débloque.

`node test/boucle.test.js`, avec `AIDER_CLI=__fixtures__/aider-stub.sh` et
`GH_CLI=__fixtures__/gh-stub.sh`, sur un dépôt git jetable créé par le test. Couvre les
cinq scénarios du lot 3c et les quatre du lot 3b, dont :

- **R7** : une `validation-command` qui affiche `process.env.GH_TOKEN` doit afficher
  `undefined`. Le test de sécurité le plus important du dépôt.
- **R3** : le stub écrit `.github/workflows/ci.yml` → le chemin est refusé et
  n'apparaît pas dans `git log --name-only`.
- **R8** : le stub écrit `.aider.conf.yml` → refusé.
- **R6** : une fixture avec un `<!-- … -->` → le bloc est absent du prompt construit.
- **R4** : le stub n'écrit rien → aucune PR, code de sortie 0.
- Le compte d'itérations, avec `MAX_ITERATIONS=2`.

Ce job est ce qui rend les lots 3b et 3c **signables par leur exécutant**. Dans la
version précédente, ils ne l'étaient pas : leur seule vérification exigeait une vraie
clé API et un dépôt distant.

## Job 4 — Smoke du composite, en local

```yaml
smoke-local:
  runs-on: ubuntu-24.04
  steps:
    - uses: actions/checkout@v5
    - id: action
      uses: ./
      with:
        deepseek-api-key: factice
        github-token: ${{ secrets.GITHUB_TOKEN }}
        no-publish: 'true'
    - run: |
        test "${{ steps.action.outputs.poursuivre }}" = "false"
```

Ce job monte réellement l'action : il valide la syntaxe de `runs:`, la présence des
`shell:`, la résolution des `uses:` internes et la remontée des `outputs:`.

Il **s'arrête à la garde** : l'événement est `pull_request` ou `push`, donc la liste
blanche d'événements du lot 2 refuse, `poursuivre=false`, code 0. aider n'est jamais
installé, la clé factice n'est jamais utilisée, le job passe en quelques secondes.

L'assertion sur `outputs.poursuivre` compte : sans elle, ce job ne fait que « ne pas
planter ». C'est pour cela que le lot 4 expose des `outputs:`.

**Ce que ce job ne valide pas**, contrairement à ce qu'affirmait la version précédente :

- **pas le câblage des `env:`** — les steps qui les portent sont sautés par le `if:`.
  C'est le contrôle programmatique du job 1 qui s'en charge.
- **pas la résolution de `$GITHUB_ACTION_PATH`** — en `uses: ./`, cette variable vaut
  `GITHUB_WORKSPACE` (`ActionManager.cs:697-704`). Un `node scripts/garde.js` en chemin
  **relatif** passerait ce job et casserait chez tout consommateur en
  `uses: owner/repo@v1`. D'où le job 5.

## Job 5 — Smoke du composite, par référence distante

```yaml
smoke-distant:
  if: github.event_name == 'push'
  runs-on: ubuntu-24.04
  steps:
    - uses: citopia-jvs/deepseek-resolve-github-action@${{ github.sha }}
      with:
        deepseek-api-key: factice
        no-publish: 'true'
```

Le seul job qui exerce `GITHUB_ACTION_PATH` avec sa vraie valeur,
`_actions/<owner>/<repo>/<ref>`. Sans lui, l'écart entre local et distant reste invisible
jusqu'au premier consommateur.

Restreint à `push` : une référence par SHA n'est résolvable qu'une fois le commit sur le
dépôt. Sur une PR de branche du même dépôt, `github.sha` fonctionne aussi ; sur une PR de
fork, non. Assumer, et le noter dans le fichier.

## Ce qui n'est pas testable ici

La boucle avec un vrai modèle : elle demande une clé API et un vrai dépôt à modifier.
Elle relève de la vérification de bout en bout du plan maître.

**Ne pas mettre de clé DeepSeek dans les secrets de ce dépôt** : un workflow déclenché
depuis une PR de fork y aurait accès dans certaines configurations.

## Vérification

Les cinq jobs passent sur une PR. Vérifier aussi qu'ils **échouent** quand on les casse
volontairement :

- une faute de syntaxe dans un script → job 1 ;
- un nom d'input mal orthographié dans `action.yml` → job 1, contrôle de cohérence ;
- retirer un `shell:` → job 4 ;
- remplacer `$GITHUB_ACTION_PATH/scripts/garde.js` par `scripts/garde.js` → job 4 passe,
  job 5 **échoue**. C'est la démonstration que le job 5 sert à quelque chose ;
- retirer le filtrage d'environnement de `executerValidation` → job 3, cas R7.

Un test qui ne peut pas échouer ne teste rien.
