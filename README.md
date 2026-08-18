# DeepSeek Auto-Resolve Issue

GitHub Action qui tente de résoudre automatiquement une issue avec l'API DeepSeek.

Quand une issue — ou un commentaire d'issue — contient `@dseek`, l'action crée une
branche, ouvre une Pull Request, puis boucle : elle demande à DeepSeek d'analyser
le problème, de proposer des modifications, les commite, exécute la commande de
validation du projet, et recommence en lui transmettant les erreurs tant que la
validation échoue.

> **⚠️ Projet en cours de développement.** L'action n'est pas encore
> fonctionnelle : plusieurs fonctions du client GitHub sont déclarées mais pas
> implémentées, et l'action n'est pas packagée pour le runtime GitHub Actions.
> Voir [État du projet](#état-du-projet).

## Utilisation

Dans le dépôt à équiper, créer `.github/workflows/dseek.yml` :

```yaml
name: DeepSeek Auto-Resolve

on:
  issues:
    types: [opened, edited]
  issue_comment:
    types: [created, edited]

jobs:
  resolve:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      issues: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - run: npm ci

      - uses: citopia-jvs/deepseek-resolve-github-action@v1
        with:
          deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          max-iterations: 3
          validation-command: npm test
```

L'étape `actions/checkout` est obligatoire : la commande de validation est
exécutée dans le répertoire de travail du runner. Les étapes `setup-node` et
`npm ci` ne sont nécessaires que si la commande de validation en dépend.

Il ne reste plus qu'à écrire `@dseek` dans une issue ou dans un commentaire. Une
réaction 👀 confirme la prise en compte.

## Entrées

| Nom | Requis | Défaut | Description |
| --- | --- | --- | --- |
| `deepseek-api-key` | oui | — | Clé API DeepSeek. À stocker dans les secrets du dépôt. |
| `github-token` | oui | — | Token avec droits d'écriture sur le contenu, les issues et les PR. Passer `${{ secrets.GITHUB_TOKEN }}` explicitement. |
| `max-iterations` | non | `2` | Nombre maximum de cycles réflexion / correction / validation. |
| `validation-command` | non | `npm test` | Commande qui décide si la solution est acceptée. Code de sortie `0` = succès. |
| `base-branch` | non | branche par défaut du dépôt | Branche de départ de la nouvelle branche et cible de la PR. |

## Fonctionnement

1. **Détection.** L'action ne fait rien si le corps de l'issue ou du commentaire
   ne contient pas `@dseek`. Elle s'arrête également si une PR ouverte existe
   déjà pour la branche `fix-issue-<numéro>`.
2. **Préparation.** Création de la branche `fix-issue-<numéro>` depuis la branche
   de base, puis ouverture de la Pull Request.
3. **Boucle d'itération**, répétée jusqu'à `max-iterations` :
   - **Réflexion** — DeepSeek analyse l'issue et le code, et produit un plan,
     sans écrire de code.
   - **Correction** — à partir de ce plan, DeepSeek renvoie un objet JSON
     associant chaque chemin de fichier à son nouveau contenu complet.
   - **Commit** — les modifications sont poussées sur la branche.
   - **Validation** — `validation-command` est exécutée. En cas d'échec, les
     logs sont réinjectés dans le prompt de l'itération suivante.
   - Chaque itération donne lieu à un commentaire sur la PR.
4. **Conclusion.** Un commentaire final indique le succès et le nombre
   d'itérations, ou l'échec et sa cause.

## Coût et limites

- **Toute la base de code part dans chaque prompt.** L'action lit le contenu de
  tous les fichiers de moins de 100 Ko et les sérialise dans les deux prompts de
  chaque itération. Sur un dépôt de taille réelle, la fenêtre de contexte est
  dépassée et la consommation de jetons devient importante. Réserver l'usage à de
  petits dépôts en l'état.
- **Fichiers réécrits en entier.** DeepSeek renvoie le contenu complet des
  fichiers modifiés, pas un diff. Un fichier volumineux est donc régénéré
  intégralement, avec le risque de perte de contenu que cela implique.
- **Le code validé n'est pas le code commité.** Les modifications sont écrites
  via l'API GitHub sur la branche, tandis que la validation s'exécute sur le
  checkout du runner, qui n'est pas rafraîchi entre-temps.
- Aucune limite de dépense n'est appliquée : `max-iterations` est le seul
  garde-fou.

## Développement

```bash
npm install
```

Le dépôt ne comporte ni tests ni linter. Pour exercer l'action en local, simuler
l'environnement GitHub Actions :

```bash
INPUT_DEEPSEEK-API-KEY=sk-... \
INPUT_GITHUB-TOKEN=ghp_... \
GITHUB_REPOSITORY=owner/repo \
GITHUB_EVENT_PATH=./event.json \
node src/index.js
```

où `event.json` contient un payload d'événement `issues` ou `issue_comment`.

### Structure

| Fichier | Rôle |
| --- | --- |
| `src/index.js` | Orchestration et boucle d'itération. |
| `src/deepseek-client.js` | Appel à l'API DeepSeek (`deepseek-chat`). |
| `src/github-client.js` | Interactions Octokit : lecture de l'arbre, contenu des fichiers, écritures. |
| `action.yml` | Métadonnées et entrées de l'action. |

## État du projet

Travaux restants avant une première version utilisable :

- [ ] Implémenter `addReaction`, `createBranch`, `createPR`, `commitChanges` et
      `commentOnPR` dans `src/github-client.js` — elles sont exportées mais
      absentes, ce qui fait échouer le chargement de `src/index.js`.
- [ ] Synchroniser le checkout du runner avec les commits effectués via l'API
      avant d'exécuter la validation.
- [ ] Sélectionner les fichiers pertinents plutôt que d'envoyer tout le dépôt.
- [ ] Packager avec `@vercel/ncc` vers `dist/index.js` et passer `action.yml` à
      `node20` — le runner n'installe pas les dépendances.
- [ ] Remplir le workflow `.github/workflows/test.yml`, aujourd'hui vide.
