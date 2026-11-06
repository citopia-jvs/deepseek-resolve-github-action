# DeepSeek Auto-Resolve Issue

GitHub Action qui tente de résoudre automatiquement une issue avec
[Claude Code](https://code.claude.com), branché sur un modèle de
[Scaleway Generative APIs](https://www.scaleway.com/fr/generative-apis/) par un
petit proxy livré avec l'action.

Quand une issue — ou un commentaire d'issue — contient `@agent`, écrit par quelqu'un
qui a le droit d'écriture, l'action déroule tout le processus :

1. **prise en compte** : un commentaire sur l'issue annonce la pull request ;
2. **branche** `fix-issue-<n>` ;
3. **pull request en brouillon**, ouverte tout de suite sur un commit vide ;
4. **résolution** par Claude Code, qui lit et modifie les fichiers du dépôt ;
5. **vérification** : l'action lance elle-même la commande de validation. Si elle
   échoue, Claude Code reçoit la sortie des tests et a **une** seconde chance ;
6. **demande de revue** : tests verts, la PR passe en « prête » et la revue est
   demandée à l'auteur du `@agent`. Tests rouges après deux passages, le travail est
   quand même poussé et la PR reste en brouillon, avec un commentaire qui dit
   pourquoi.

Le nom du dépôt est historique : jusqu'à `v1`, l'action pilotait
[aider](https://aider.chat) avec un modèle DeepSeek. `v1` reste disponible et ne
bouge plus.

> **⚠️ Projet en cours de développement.** Le déroulé complet a été exécuté de bout
> en bout sur un dépôt d'essai, avec `glm-5.3`, seconde chance comprise : mesures dans
> `plan/essai-claude-code.md`. Le tag `v2` n'est pas encore posé. Lire la section
> [Sécurité](#sécurité) avant toute installation.

## Utilisation

Dans le dépôt à équiper, créer `.github/workflows/agent.yml` :

```yaml
on:
  issues:
    types: [opened]
  issue_comment:
    types: [created]

permissions:
  contents: write
  pull-requests: write
  issues: write

concurrency:
  group: agent-${{ github.event.issue.number }}
  cancel-in-progress: false

jobs:
  resoudre:
    if: >-
      (github.event_name == 'issue_comment' && contains(github.event.comment.body, '@agent')) ||
      (github.event_name == 'issues' && contains(github.event.issue.body, '@agent'))
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v5
        with:
          persist-credentials: false
      - uses: citopia-jvs/deepseek-resolve-github-action@v2
        with:
          scaleway-api-key: ${{ secrets.SCW_SECRET_KEY }}
          scaleway-base-url: ${{ vars.SCW_BASE_URL }}
          validation-command: npm test
```

Côté dépôt : un secret `SCW_SECRET_KEY` (clé d'API Scaleway) et une variable
`SCW_BASE_URL`, l'URL propre au projet Scaleway, de la forme
`https://api.scaleway.ai/<id-projet>/v1`. L'URL n'est pas un secret.

Points de cet exemple qui ne sont pas des préférences de style :

- **`persist-credentials: false` est exigé.** Sinon le jeton en écriture reste dans
  la configuration git du checkout, lisible par les tests, qui exécutent du code
  écrit par le modèle. L'action refuse de démarrer dans ce cas, avec un message qui
  le dit.
- **`runs-on: ubuntu-24.04` en dur.** L'action n'est vérifiée que sur cette image.
- **Le bloc `concurrency`.** Deux `@agent` rapprochés sur la même issue lanceraient
  deux jobs sur la même branche. Une composite action ne peut pas porter
  `concurrency` elle-même.
- **Le `if:` du job.** Il évite de démarrer un runner pour chaque commentaire
  ordinaire. Le vrai contrôle reste celui de l'action.
- **`types: [opened]` et `[created]` seulement, jamais `edited`** : rééditer un vieux
  commentaire qui contient `@agent` relancerait un cycle complet.

À savoir aussi :

- si la commande de validation a besoin de dépendances (`npm ci`,
  `actions/setup-node`…), ces steps vont **avant** l'action ;
- **ne jamais interpoler de contexte GitHub dans `validation-command`** : un
  `${{ github.event.issue.title }}` y serait une injection de script ;
- `timeout-minutes` est le vrai plafond de coût : un passage du modèle consomme
  entre 260 000 et 570 000 tokens d'entrée sur le dépôt d'essai.

## Entrées

| Nom | Requis | Défaut | Description |
| --- | --- | --- | --- |
| `scaleway-api-key` | oui | — | Clé d'API Scaleway. À passer par un secret. |
| `scaleway-base-url` | non | `https://api.scaleway.ai/v1` | URL de l'API Scaleway compatible OpenAI. L'URL propre au projet est conseillée. |
| `model` | non | `glm-5.3` | Modèle Scaleway, imposé à toutes les requêtes. |
| `context-window` | non | `256000` | Fenêtre de contexte du modèle, en tokens. Claude Code ne la connaît pas pour un modèle non-Claude. |
| `max-turns` | non | `30` | Nombre maximum de tours de Claude Code par passage. |
| `github-token` | non | `${{ github.token }}` | Jeton utilisé pour pousser, ouvrir la PR et commenter. |
| `validation-command` | non | `npm test` | Commande exécutée dans le checkout. Code de sortie `0` = succès. |
| `base-branch` | non | *(vide)* | Branche de base de la PR. Vide : la branche du checkout. |
| `allowed-associations` | non | `OWNER,MEMBER,COLLABORATOR` | Associations au dépôt autorisées à déclencher l'action. |
| `require-trusted-issue-author` | non | `true` | Exiger que l'auteur de l'issue soit lui aussi de confiance pour que son corps serve de consigne. |

## Sorties

| Nom | Description |
| --- | --- |
| `poursuivre` | `"true"` si la garde a autorisé l'exécution, `"false"` sinon. |
| `branche` | Nom de la branche de travail, `fix-issue-<n>`. |
| `numero-pr` | Numéro de la pull request, vide si aucune n'a été ouverte. |
| `succes` | `"true"` seulement si la validation est passée et le travail poussé. |

## Fonctionnement

L'action est une composite action. Le détail de ses steps, avec la condition de
chaque step, est dans `plan/contrat.md`, « Déroulé de `action.yml` ».

- **`garde`** (`scripts/garde.js`) : refuse tout événement autre que `issues` et
  `issue_comment`, toute mention absente, et tout auteur sans droit d'écriture.
- **`preparer`** (`scripts/preparer.js`) : crée ou reprend la branche, pousse le
  commit vide, ouvre la PR brouillon, rédige la consigne et la publie dans la PR.
- **`proxy`** : lance `scripts/proxy.js`, qui traduit l'API Anthropic que parle
  Claude Code vers l'API OpenAI de Scaleway.
- **`claude1`**, puis **`claude2`** si les tests ont échoué :
  [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action),
  épinglée par SHA, en mode agent. Claude Code n'y a **pas** Bash : il lit et
  modifie des fichiers, rien d'autre.
- **`verifier1`**, **`verifier2`** (`scripts/verifier.js`) : lancent la commande
  de validation, sans le jeton GitHub.
- **`conclure`** (`scripts/conclure.js`) : commite les seuls chemins autorisés,
  pousse, passe la PR en prête et demande la revue, ou la laisse en brouillon. Le
  commentaire reprend la dernière réponse du modèle : c'est là qu'il explique ce
  qu'il n'a pas pu faire.

## Sécurité

Cette action fait **exécuter dans le runner du code écrit par un modèle, à partir
d'un texte que n'importe qui peut rédiger.** C'est vrai même quand seuls des comptes
de confiance peuvent la déclencher : le déclencheur et l'auteur de l'issue ne sont
pas forcément la même personne.

### Ce que la garde fait, et ce qu'elle ne fait pas

Elle contrôle **qui déclenche**, en deux étages cumulatifs : l'association déclarée
par GitHub sur l'événement, **puis** la permission effective du compte sur le dépôt —
`write`, `maintain` ou `admin`. Un mainteneur rapporté `CONTRIBUTOR` est donc refusé
au premier étage ; l'ajouter à `allowed-associations` élargit le premier filtre, pas
la porte, puisque le second étage reste exigé.

Elle ne contrôle **pas** le texte. Un inconnu peut glisser une consigne dans un bloc
`<!-- … -->`, invisible dans le rendu GitHub, qu'un mainteneur fera exécuter en
commentant `@agent`. Ce que l'action fait contre ça : la consigne vient du texte de
la personne autorisée, le corps de l'issue est fourni comme donnée délimitée et
étiquetée non fiable, les commentaires HTML sont retirés, et la consigne exacte est
publiée dans la PR. **Aucune de ces mesures n'est une barrière.**

### Ce que le modèle peut atteindre

`claude-code-action` place le jeton GitHub dans l'environnement de Claude Code. C'est
pourquoi Claude Code n'a pas Bash : tout code qu'il exécuterait pourrait lire ce
jeton. Les tests, qui exécutent le code écrit par le modèle, sont lancés par l'action
dans un step qui ne reçoit pas le jeton, avec un environnement filtré et la
configuration git restaurée. Mesuré sur un runner : un test écrit par le modèle ne
voit aucun jeton.

Le commit refuse les chemins qu'un dépôt exécute sans relecture — `.github/**`,
`action.yml`, CI, `package.json` et verrous, configuration de test, `Makefile`,
`Dockerfile*`, hooks, `.env*`, `.claude/**`, `CLAUDE.md`, `.mcp.json` — et refuse
tout commit qui contiendrait le jeton.

**Risque résiduel, non fermé :** les tests tournent sous le même utilisateur que les
steps suivants. Un processus laissé en tâche de fond par un test pourrait lire
l'environnement du step qui commite et pousse, donc le jeton. Le fermer demanderait
de lancer les tests dans un conteneur ou dans un job sans jeton.

### Consignes fermes

- **Jamais `pull_request_target`** avec cette action.
- `permissions:` minimal, comme dans l'exemple. **Aucun autre secret** dans le job.
- Clé Scaleway **dédiée** à cette action, avec un plafond de consommation.
- `timeout-minutes` sur le job, `persist-credentials: false` sur le checkout.
- **Jamais d'auto-merge.** Protection de branche et revue obligatoire sur la branche
  par défaut.
- Ne pas installer cette action sur un dépôt qui détient des secrets qui comptent.

### Deux arbitrages à faire avant d'installer cette action

1. **Le code source part chez Scaleway**, à chaque requête du modèle. Scaleway est un
   hébergeur européen ; à valider quand même avant usage sur un dépôt privé.
2. **Conditions d'utilisation de Claude Code.** L'action fait tourner Claude Code
   avec un modèle qui n'est pas un modèle Anthropic. La compatibilité de cet usage
   avec les conditions d'Anthropic n'a pas été vérifiée.

## Limites connues

- **Une seule seconde chance.** Si les tests échouent deux fois, l'action s'arrête.
  Ce chemin est écrit et couvert par les suites hors ligne, mais n'a pas encore été
  exécuté sur un runner.
- **La CI de la PR ne démarre pas seule.** Une PR créée avec `GITHUB_TOKEN` ne
  déclenche pas les workflows `pull_request` sans approbation manuelle, et aucun
  autre événement. Le contournement par jeton personnel est déconseillé : il rendrait
  inopérant le refus des chemins de workflow.
- **Pas de PR depuis une PR.** Seuls `issues` et `issue_comment` sont pris en charge.
- **La sortie maximale de `glm-5.3` n'est pas connue.** Le proxy borne `max_tokens`
  à 16 384.
- **Coût :** environ 21 000 tokens d'entrée par requête, dus au prompt système de
  Claude Code, sans cache.

## Développement

Aucune dépendance, aucun build — bibliothèque standard Node seule.

```bash
# syntaxe — un appel par fichier
find scripts test -name '*.js' -print0 | xargs -0 -n1 node --check

# les suites du dépôt, hors ligne, sans clé API ni réseau
for suite in test/*.test.js; do node "$suite"; done
```

### Structure

```
action.yml                 # composite action : les steps
scripts/garde.js           # événement, autorisation, anti-rejeu
scripts/preparer.js        # branche, commit vide, PR brouillon, consigne
scripts/proxy.js           # proxy Anthropic → OpenAI vers Scaleway
scripts/verifier.js        # commande de validation, sans le jeton
scripts/conclure.js        # commit, push, PR prête et revue, ou brouillon
scripts/lib/               # gh, git, chemins, texte, traduction, action
__fixtures__/              # payloads d'événements, stub gh
test/                      # les suites, lancées par le glob test/*.test.js
plan/                      # contrat.md (source des noms), mesures des essais
```
