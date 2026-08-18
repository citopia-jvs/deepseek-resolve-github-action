# Contrat d'interface

**À lire en premier, avant tout lot.** Ce fichier est la seule source de vérité pour
les noms : sorties, variables d'environnement, inputs, signatures. Aucun lot ne
redéfinit un nom ; s'il faut en ajouter un, il s'ajoute **ici** d'abord.

Raison d'être : dans la version précédente de ce plan, ces noms n'existaient que
dans le lot 4, alors que les lots 2, 3a, 3b et 3c les consomment. Un agent écrivant
le lot 3b sans avoir lu le lot 4 inventait ses propres noms, et le lot 4 devait tout
renommer.

## Versions épinglées

Ces valeurs ne sont pas des points ouverts. Elles sont relevées et vérifiées.

| Quoi | Valeur | Pourquoi cette valeur |
| --- | --- | --- |
| `aider-chat` | `0.86.2` | dernière version sur PyPI (2026-02-12). 174 releases, rien depuis. |
| Python | `3.12` | `aider-chat` déclare `requires_python = "<3.13,>=3.10"`. |
| Modèle par défaut | `deepseek/deepseek-v4-pro` | seuls `deepseek-v4-pro` et `deepseek-v4-flash` existent côté API. |
| `actions/checkout` | `v5` | `v4` déclare `using: node20`, retiré des runners le 2026-09-16. |
| Runner | `ubuntu-24.04` **en dur** | `ubuntu-latest` basculera sur 26.04, dont le Python 3.14.4 est hors borne. |

## Sorties de `scripts/garde.js` (dans `GITHUB_OUTPUT`)

| Sortie | Type | Valeur |
| --- | --- | --- |
| `poursuivre` | `'true'` \| `'false'` | écrite sur **tous** les chemins, y compris les refus |
| `issue` | entier décimal | numéro d'issue, validé `Number.isInteger` |
| `branche` | `fix-issue-<n>` | validée contre `/^fix-issue-\d+$/`. **Fait foi** : `resolve.js` ne la reconstruit pas |
| `motif` | chaîne courte | motif du refus, pour le compte rendu. Vide si `poursuivre=true` |

## Variables d'environnement lues par les scripts

Une composite action **n'expose pas** ses inputs en `INPUT_*` aux sous-processus.
Chaque valeur doit figurer dans le `env:` de son step. C'est l'oubli le plus
probable de tout le plan.

### `garde.js`

| Variable | Source |
| --- | --- |
| `GITHUB_EVENT_PATH`, `GITHUB_EVENT_NAME`, `GITHUB_REPOSITORY`, `GITHUB_OUTPUT` | runner |
| `GH_TOKEN` | input `github-token` |
| `ASSOCIATIONS_AUTORISEES` | input `allowed-associations` |
| `EXIGER_AUTEUR_ISSUE_DE_CONFIANCE` | input `require-trusted-issue-author` |
| `GH_CLI` | tests seulement — binaire `gh` injectable |

### `resolve.js`

| Variable | Source |
| --- | --- |
| `GITHUB_EVENT_PATH`, `GITHUB_REPOSITORY`, `GITHUB_WORKSPACE`, `GITHUB_ACTION_PATH` | runner |
| `DEEPSEEK_API_KEY` | input `deepseek-api-key` |
| `GH_TOKEN` | input `github-token` |
| `NUMERO_ISSUE` | sortie `issue` de la garde |
| `BRANCHE` | sortie `branche` de la garde |
| `MODELE` | input `model` |
| `MAX_ITERATIONS` | input `max-iterations` |
| `COMMANDE_VALIDATION` | input `validation-command` |
| `BRANCHE_BASE` | input `base-branch` |
| `MAP_TOKENS` | input `map-tokens` |
| `SANS_PUBLICATION` | input `no-publish` |
| `MINUTES_MAX_APPEL_AIDER` | input `aider-call-timeout-minutes` |
| `GH_CLI`, `AIDER_CLI` | tests seulement — binaires injectables |

### `rendre-compte.js`

`GH_TOKEN`, `GITHUB_REPOSITORY`, `NUMERO_ISSUE`, `BRANCHE`, `STATUT_JOB`
(`${{ job.status }}`), `SANS_PUBLICATION`.

## Inputs de `action.yml`

| Input | Requis | Défaut | Exposé sous |
| --- | --- | --- | --- |
| `deepseek-api-key` | oui | — | `DEEPSEEK_API_KEY` |
| `github-token` | non | `${{ github.token }}` | `GH_TOKEN` |
| `max-iterations` | non | `"2"` | `MAX_ITERATIONS` |
| `validation-command` | non | `"npm test"` | `COMMANDE_VALIDATION` |
| `base-branch` | non | `""` | `BRANCHE_BASE` |
| `model` | non | `"deepseek/deepseek-v4-pro"` | `MODELE` |
| `aider-version` | non | `"0.86.2"` | interpolé dans l'install |
| `python-version` | non | `"3.12"` | `actions/setup-python` |
| `map-tokens` | non | `"2048"` | `MAP_TOKENS` |
| `allowed-associations` | non | `"OWNER,MEMBER,COLLABORATOR"` | `ASSOCIATIONS_AUTORISEES` |
| `require-trusted-issue-author` | non | `"true"` | `EXIGER_AUTEUR_ISSUE_DE_CONFIANCE` |
| `no-publish` | non | `"false"` | `SANS_PUBLICATION` |
| `aider-call-timeout-minutes` | non | `"15"` | `MINUTES_MAX_APPEL_AIDER` |

`github-token` n'est **pas** `required: true` : `required` avec un `default` est
contradictoire, et GitHub n'applique de toute façon pas `required` sur les inputs
d'action.

Tous les inputs sont des **chaînes**. Côté script, ne comparer qu'à `'true'`,
jamais à `'false'`.

## Outputs de `action.yml`

`poursuivre`, `numero-pr`, `branche`, `iterations`, `succes`. Sans eux, un
consommateur ne peut rien enchaîner et le smoke test du lot 5 n'a rien à contrôler.

## Signatures exportées par `scripts/lib/`

```js
// gh.js
gh(args, { json = false, tolererEchec = false })   // --repo ajouté par l'appelant
// git.js
git(args, { tolererEchec = false })                // stdout trimmé
aDesCommits(base)                                  // booléen
etatFichiers()                                     // [{ statut, chemin }] — pas juste des chemins
brancheDistanteExiste(nom)                         // booléen
// chemins.js
estCheminInterdit(chemin)                          // booléen — liste du lot 3b
normaliser(chemin)                                 // refuse '..', absolus, liens
// texte.js
nettoyerTexteTiers(s)                              // retire commentaires HTML, contrôles, bidi
masquerSecrets(s)                                  // motifs de jetons -> [SECRET RETIRÉ]
tronquer(s, n)                                     // tête + queue
```

## Signatures des primitives de `resolve.js` (lot 3b)

Le lot 3c les compose et n'en écrit aucune.

```js
appelerAider(consigne)          // -> { codeSortie, sortie }
executerValidation()            // -> { codeSortie, logs }   env filtrée
commiterTravail(message)        // -> { commite: bool, refuses: string[] }
publierInitial(prompt)          // -> { numeroPr }            push + gh pr create
publierTour(i, resultat)        // -> void                    commentaire de PR
publierCompteRendu(bilan)       // -> void
```
