# Lot 8 — Branche de travail, publication, rollback

**Dépend de** : lot 5 vert.

## Pourquoi ce lot existe

La version précédente du plan consacrait une ligne au sujet (« tag `v1` une fois le bout
en bout vert »). Trois choses manquaient : la stratégie de branche pendant les huit lots
où le dépôt est cassé, la convention de tags, et le rollback.

## État de départ, vérifié

`git tag` est **vide**. Aucune version n'a jamais été publiée, donc :

- **aucun utilisateur à migrer** — c'est ce qui autorise à casser l'action pendant huit
  lots et à ignorer toute rétrocompatibilité ;
- aucune contrainte de nommage héritée.

Le remote est `citopia-jvs/deepseek-resolve-github-action`.

## Branche de travail

Tout le plan se déroule sur `feat/composite-aider`.

Raison : entre le lot 0 (qui supprime `src/index.js`) et le lot 4 (qui réécrit
`action.yml`), le fichier `action.yml` déclare `main: src/index.js` sur un fichier qui
n'existe plus. L'action est totalement inutilisable. Sans tag, personne ne le voit — mais
la CI du lot 5 doit pouvoir tourner sur une PR avant que ce code atterrisse sur `main`.

Fusion de la PR après le lot 5 vert. Les lots 6 et 7 peuvent suivre dans la même PR ou
dans une seconde, au choix.

## Convention de tags

| Tag | Nature | Rôle |
| --- | --- | --- |
| `v1.0.0` | **immuable** | version exacte, jamais déplacée |
| `v1` | **flottant** | déplacé sur le dernier `v1.x.y` vert |

C'est la convention des actions GitHub : un consommateur écrit `@v1` et reçoit les
correctifs, ou `@v1.0.0` et reçoit exactement ce qu'il a relu. Un consommateur exigeant
peut aussi épingler un SHA.

Aucune étape de build : le tag pointe directement le code exécuté. C'est le bénéfice du
composite.

## Ce qui doit être vert avant le premier tag

1. Les cinq jobs de la CI du lot 5.
2. Les onze cas de la vérification de bout en bout du plan maître, dont ceux qui exigent
   une vraie clé DeepSeek.

Ne pas taguer `v1` sur un bout en bout partiellement vérifié : les cas 4 à 11 sont
précisément ceux qui couvrent les risques R2, R3, R4, R6, R8, R9 et R12.

## Rollback

`v1` reste sur le dernier commit vert. Les `v1.x.y` sont immuables, donc un consommateur
qui a épinglé une version exacte n'est jamais affecté par une régression amont.

En cas de régression découverte après publication : déplacer `v1` sur le `v1.x.y`
précédent. Ne jamais réécrire un tag immuable — un consommateur pourrait avoir mis en
cache le SHA.

## Ce qui fait de la montée de version un acte délibéré

`aider-version` est épinglé en dur dans `action.yml`. Le changer :

- installe 301 paquets tiers différents dans le runner de chaque consommateur ;
- oblige à revérifier `aider-models.json` : c'est la version d'aider qui détermine quelle
  table de modèles litellm est embarquée, et donc si les modèles DeepSeek courants sont
  connus (R5) ;
- oblige à revérifier les défauts des flags sur lesquels le lot 3b s'appuie, en
  particulier le refus des commandes shell par `--yes-always`, qui est un détail
  d'implémentation non documenté comme garantie.

Donc : une montée d'`aider-version` est un `v1.(x+1).0`, avec relecture, pas un
correctif.

## Vérification

- `git tag` montre `v1` et `v1.0.0` pointant le même commit.
- Un dépôt de test consommant `@v1` fonctionne (c'est le job 5 de la CI, avec un SHA
  plutôt qu'un tag).
- Un dépôt de test consommant `@v1.0.0` fonctionne aussi.
