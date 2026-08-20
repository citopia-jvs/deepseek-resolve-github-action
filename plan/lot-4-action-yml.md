# Lot 4 — `action.yml` en composite

**Dépend de** : lots 2 et 3c. Lire [`contrat.md`](contrat.md) : la table d'inputs y est,
ce lot la transcrit sans rien inventer.

## Objectif

Remplacer la JS action par une composite action. C'est ce lot qui supprime la question
du packaging : plus de `node_modules` à committer, plus de bundling `ncc`, plus de
`dist/`, plus de `using: node16` déprécié.

Ce lot livre aussi `scripts/rendre-compte.js`, `aider.conf.yml` et `aider-models.json`.

## État actuel

`action.yml` déclare `using: node16` et `main: src/index.js`, sans étape de bundling.
`node16` est déprécié, et le runner n'exécute pas `npm install`, donc
`require('@actions/core')` échouerait au chargement. Les deux disparaissent avec le
composite. Corriger aussi `author`, qui vaut aujourd'hui `"Votre Nom"`. Conserver
`branding` (`icon: cpu`, `color: blue`).

## Inputs

Treize, listés dans le contrat. Trois notes qui n'y tiennent pas :

- **`model`** : défaut `deepseek/deepseek-v4-pro`. `deepseek-chat` et
  `deepseek-reasoner` sont **retirés de l'API depuis le 2026-07-24** ; il ne reste que
  `deepseek-v4-pro` et `deepseek-v4-flash`, 1 M de contexte.
- **`aider-version`** : défaut `0.86.2`, en dur. C'est la dernière version publiée
  (2026-02-12) ; le dépôt n'a rien sorti depuis six mois. Une action publiée ne doit pas
  installer un `latest` mouvant. Et monter cette valeur oblige à revérifier
  `aider-models.json` (R5) : c'est voulu.
- **`github-token`** : `required: false` avec `default: ${{ github.token }}`.
  `required: true` **et** un défaut est contradictoire, et GitHub n'applique de toute
  façon pas `required` sur les inputs d'action. La version précédente avait les deux.

## Outputs

Manquants dans la version précédente. Sans eux, un consommateur ne peut rien enchaîner
— étiqueter la PR, notifier, mesurer — et le smoke test du lot 5 n'a rien à contrôler :
il se contente de « ne pas planter ».

```yaml
outputs:
  poursuivre: { value: "${{ steps.garde.outputs.poursuivre }}" }
  branche:    { value: "${{ steps.garde.outputs.branche }}" }
  numero-pr:  { value: "${{ steps.resoudre.outputs.numero-pr }}" }
  iterations: { value: "${{ steps.resoudre.outputs.iterations }}" }
  succes:     { value: "${{ steps.resoudre.outputs.succes }}" }
```

## `runs`

**Cinq** steps. Ce lot écrivait « quatre » ici et « quatrième step » plus bas pour
désigner le compte rendu, alors que son propre bloc YAML en porte cinq (garde,
`setup-python`, installation d'aider, `resoudre`, compte rendu). Corrigé : deux comptes
contradictoires dans le même fichier obligent le lecteur à recompter.

```yaml
runs:
  using: composite
  steps:
    - id: garde
      shell: bash
      env:
        GH_TOKEN: ${{ inputs.github-token }}
        ASSOCIATIONS_AUTORISEES: ${{ inputs.allowed-associations }}
        EXIGER_AUTEUR_ISSUE_DE_CONFIANCE: ${{ inputs.require-trusted-issue-author }}
      run: node "$GITHUB_ACTION_PATH/scripts/garde.js"

    - if: steps.garde.outputs.poursuivre == 'true'
      uses: actions/setup-python@v6
      with:
        python-version: ${{ inputs.python-version }}

    - if: steps.garde.outputs.poursuivre == 'true'
      shell: bash
      run: |
        command -v pipx >/dev/null || {
          echo "::error::pipx introuvable. Cette action requiert un runner ubuntu-24.04."
          exit 1
        }
        pipx install --python "$(which python)" "aider-chat==${{ inputs.aider-version }}"

    - id: resoudre
      if: steps.garde.outputs.poursuivre == 'true'
      shell: bash
      env:
        DEEPSEEK_API_KEY: ${{ inputs.deepseek-api-key }}
        GH_TOKEN: ${{ inputs.github-token }}
        NUMERO_ISSUE: ${{ steps.garde.outputs.issue }}
        BRANCHE: ${{ steps.garde.outputs.branche }}
        MODELE: ${{ inputs.model }}
        MAX_ITERATIONS: ${{ inputs.max-iterations }}
        COMMANDE_VALIDATION: ${{ inputs.validation-command }}
        BRANCHE_BASE: ${{ inputs.base-branch }}
        MAP_TOKENS: ${{ inputs.map-tokens }}
        SANS_PUBLICATION: ${{ inputs.no-publish }}
        MINUTES_MAX_APPEL_AIDER: ${{ inputs.aider-call-timeout-minutes }}
        CONSIGNE_RESTREINTE: ${{ steps.garde.outputs.consigne-restreinte }}
      run: node "$GITHUB_ACTION_PATH/scripts/resolve.js"

    - if: always() && steps.garde.outputs.poursuivre == 'true'
      shell: bash
      env:
        GH_TOKEN: ${{ inputs.github-token }}
        NUMERO_ISSUE: ${{ steps.garde.outputs.issue }}
        BRANCHE: ${{ steps.garde.outputs.branche }}
        SANS_PUBLICATION: ${{ inputs.no-publish }}
        STATUT_JOB: ${{ job.status }}
      run: node "$GITHUB_ACTION_PATH/scripts/rendre-compte.js"
```

## `actions/setup-python` — R11

Nouveau dans cette version du plan, et non facultatif.

`aider-chat 0.86.2` déclare `requires_python = "<3.13,>=3.10"`. Or :

| Image | Python par défaut |
| --- | --- |
| Ubuntu 24.04 (= `ubuntu-latest` aujourd'hui) | 3.12.3 ✔ |
| Ubuntu 26.04 (aperçu, futur `ubuntu-latest`) | **3.14.4** ✘ |

Sans épinglage, `pipx install aider-chat` échouera à la résolution le jour où
`ubuntu-latest` basculera. Un step `uses:` est autorisé dans une composite action.

**Correction apportée à l'implémentation : `@v6`, pas `@v5`.** Ce lot écrivait
`actions/setup-python@v5`. Mesuré sur les `action.yml` publiés : `setup-python@v5`
déclare `using: 'node20'`, `setup-python@v6` déclare `using: 'node24'`. Le contrat
épingle déjà `actions/checkout@v5` parce que `node20` quitte les runners le
2026-09-16 ; garder `setup-python@v5` livrerait une action qui meurt à cette même
date. Table des versions épinglées du contrat mise à jour.

`pipx` lui-même n'a pas besoin d'être installé : les images Ubuntu 24.04 et 26.04
embarquent `pipx 1.16.6`. Le `command -v pipx` sert au cas d'un runner auto-hébergé,
macOS ou Windows, où l'erreur serait sinon opaque. Éviter l'installeur officiel d'aider
en `curl … | sh` dans une action publiée.

## Le cinquième step, en `if: always()` — R12

Une composite action **n'a pas de `post:`** : le schéma `composite-runs` ne connaît que
`{using, steps}`. Sans ce cinquième step, un `resolve.js` qui plante, un
`timeout-minutes` du consommateur qui tombe, ou un job annulé ne laissent que la
réaction 👀 sur l'issue : aucun commentaire, aucun signal. C'est exactement le scénario
« l'utilisateur attend et ne comprend pas ».

`always()`, `failure()` et `cancelled()` sont autorisés dans le `if:` d'un step
composite.

`rendre-compte.js` doit être idempotent : si `resolve.js` a déjà publié son compte
rendu, ne rien republier. Lire `STATUT_JOB` et le dernier commentaire de la PR.

## Trois points à ne pas manquer

0. **`CONSIGNE_RESTREINTE` manquait dans le bloc `env:` ci-dessus**, ligne ajoutée à
   l'implémentation. Le contrat la liste pour `resolve.js` depuis le lot 2, et c'est
   elle qui porte l'atténuation de R6 : sans la ligne, `resolve.js` lit une chaîne
   vide, donc « auteur de confiance », donc il reprend le corps de l'issue comme
   consigne alors que la garde venait de juger son auteur non autorisé. Aucune erreur,
   aucun test rouge — exactement le mode de panne que ce lot annonce comme le plus
   probable, et il était dans son propre exemple.

1. **Les inputs ne sont pas exposés automatiquement.** Contrairement à une JS action,
   une composite ne met pas les valeurs à disposition des sous-processus sous forme de
   variables `INPUT_*`. Chaque valeur doit être passée explicitement par `env:`. C'est
   la raison des blocs verbeux ci-dessus, et l'oubli le plus probable de ce lot.

2. **`GITHUB_ACTION_PATH`** pointe le répertoire de l'action déployée. Attention, sa
   valeur **dépend de la façon dont l'action est référencée** — la version précédente de
   ce plan l'ignorait :

   | Référence | Valeur |
   | --- | --- |
   | `uses: owner/repo@ref` | `/home/runner/work/_actions/<owner>/<repo>/<ref>` |
   | `uses: ./` (action locale) | **`GITHUB_WORKSPACE`** |

   (`ActionManager.cs:697-704`, branche `SelfAlias`.) Conséquence pour le lot 5 : un
   chemin **relatif** passerait le smoke test en `uses: ./` et casserait chez tout
   consommateur. Toujours passer par `$GITHUB_ACTION_PATH`, jamais par un chemin relatif.

3. **La garde tourne avant l'installation d'aider.** `pipx install aider-chat` installe
   107 paquets et prend plus d'une minute. La faire dépendre de
   `steps.garde.outputs.poursuivre` évite de la payer à chaque commentaire d'issue anodin
   — l'immense majorité des déclenchements.

## Fichiers de configuration embarqués

`aider.conf.yml` et `aider-models.json`, contenus décrits au lot 3b. Ils existent pour
que le lot 3b puisse passer `--config` et `--model-metadata-file` sur des fichiers hors
d'atteinte du modèle (R8) et pour décrire les modèles V4 que la version épinglée d'aider
ignore (R5).

## Point ouvert : `pipx` ou verrou hashé

`pipx install "aider-chat==0.86.2"` épingle en réalité **tout l'arbre** : aider déclare
ses dépendances en `==`, et PyPI interdit la réutilisation d'un nom de fichier. C'est
plus fort que la version précédente ne le croyait.

Résidu : aucun hash, donc pas de protection contre une compromission d'index ou de
miroir, et `pipx install` exécute les backends de build des sdists — du code arbitraire
à l'installation, dans un runner à `contents: write`.

L'alternative est un `python -m venv` plus
`pip install --require-hashes -r "$GITHUB_ACTION_PATH/aider-lock.txt"`, au prix d'un
fichier à régénérer à chaque montée de version. Trancher à l'implémentation. Dans les
deux cas, documenter au lot 6 : changer `aider-version` installe 107 paquets tiers dans
le runner du consommateur.

## Vérification

```bash
python3 -c "import yaml;d=yaml.safe_load(open('action.yml'));print(d['runs']['using'])"
# doit afficher : composite

# cohérence inputs <-> env: — contrôle programmatique, pas visuel
python3 - <<'PY'
import re, yaml
d = yaml.safe_load(open('action.yml'))
declares = set(d.get('inputs', {}))
utilises = set(re.findall(r'inputs\.([a-z0-9-]+)', open('action.yml').read()))
print('déclarés jamais utilisés :', sorted(declares - utilises))
print('utilisés jamais déclarés :', sorted(utilises - declares))
PY
```

Le second contrôle est nécessaire parce qu'une faute de frappe dans
`${{ inputs.mdel }}` s'évalue en **chaîne vide sans erreur** : ni le runner ni aucun
linter ne la signale.

**Deux défauts de ce bloc de vérification, relevés en l'implémentant.** Il est
remplacé par `test/action.test.js` (voir « Suites de test du dépôt » dans le contrat),
et pas seulement parce que `pyyaml` est absent du poste :

- il ne fait que `print()` les deux différences et **sort en 0 même quand elles ne
  sont pas vides**. Branché tel quel dans la CI du lot 5, il n'aurait jamais rougi ;
- son motif `r'inputs\.([a-z0-9-]+)'` est en minuscules seulement : `inputs.Model` et
  `inputs.max_iterations` lui échappent, alors que ce sont précisément des fautes de
  frappe qui s'évaluent en chaîne vide. Le test utilise `[A-Za-z0-9_-]+`. La version précédente affirmait que le smoke test du lot 5
validait le câblage des `env:` — c'était faux, les steps porteurs des `env:` sont
justement ceux que le `if:` saute.

Contrôles à l'œil, chacun ayant cassé une action réelle :

- chaque `run` step a un `shell:` (obligatoire en composite, contrairement à un workflow) ;
- les steps 2 à 5 portent le `if:` sur `steps.garde.outputs.poursuivre` ;
- le dernier step porte bien `always() &&` ;
- aucun secret écrit dans un `run:` en clair.

`actionlint` ne valide **pas** `action.yml` : il cible les fichiers de workflow. Le seul
contrôle réel est un job qui utilise l'action — lot 5.
