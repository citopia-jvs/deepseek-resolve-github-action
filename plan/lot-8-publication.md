# Lot 8 — Branche de travail, publication, rollback

**Dépend de** : lot 5 vert.

## État mesuré au moment d'exécuter ce lot

Relevé avant tout acte, parce que ce lot ne produit pas de fichier : il produit des
**actes irréversibles**, et sa propre porte les interdit tant que deux choses ne sont pas
vraies.

| Fait | Mesuré |
| --- | --- |
| `git tag` | **vide** — aucune version publiée, donc aucun utilisateur à migrer |
| Branche `feat/composite-aider` | **non poussée**. `git ls-remote --heads origin` ne rend que `refs/heads/main` |
| Commits que la branche apporte à `origin/main` | **13** |
| La CI du lot 5 | **n'a jamais tourné une seule fois** — elle ne peut pas : le workflow n'existe que sur une branche locale |
| Les onze cas de bout en bout | **aucun n'a été fait**. Sept d'entre eux exigent une vraie `DEEPSEEK_API_KEY` et un dépôt de test |
| `origin/main` contre `main` local | `origin/main` est à `64b20d0 first commit`, `main` local à `568c83d` — divergence antérieure à ce plan |

Conclusion : **les tags ne peuvent pas être posés aujourd'hui**, et ce n'est pas un
détail de calendrier. La porte ci-dessous le dit elle-même, et les cas qu'elle exige sont
précisément ceux qui couvrent R2, R3, R4, R6, R8, R9 et R12 — c'est-à-dire tout ce que
les suites hors ligne ne peuvent pas prouver.

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

1. Les **quatre** jobs de la CI du lot 5 — `syntaxe`, `suites`, `smoke-local`,
   `smoke-sous-repertoire`. Ce lot en annonçait cinq : le sixième job, à référence
   distante, a été supprimé au lot 5 parce qu'une expression n'est pas permise dans un
   `uses:`, et les cinq restants ont été fusionnés en quatre.
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

- installe 107 paquets tiers différents dans le runner de chaque consommateur ;
- oblige à revérifier `aider-models.json` : c'est la version d'aider qui détermine quelle
  table de modèles litellm est embarquée, et donc si les modèles DeepSeek courants sont
  connus (R5) ;
- oblige à revérifier les défauts des flags sur lesquels le lot 3b s'appuie, en
  particulier le refus des commandes shell par `--yes-always`, qui est un détail
  d'implémentation non documenté comme garantie.

Donc : une montée d'`aider-version` est un `v1.(x+1).0`, avec relecture, pas un
correctif.

## Les commandes, écrites une fois pour toutes

Ce lot décrivait le rollback sans dire comment le faire. Un tag flottant se déplace, et
la commande n'est pas anodine :

```bash
# première publication, une fois le bout en bout vert
git tag -a v1.0.0 -m "Première version publiée" <sha>
git tag v1 <sha>                 # léger : il va bouger
git push origin v1.0.0 v1

# correctif : nouveau tag immuable, et v1 qu'on déplace
git tag -a v1.0.1 -m "…" <sha>
git tag -f v1 <sha>
git push origin v1.0.1
git push --force origin v1       # le --force ne porte QUE sur v1

# rollback : v1 revient sur le v1.x.y précédent, qu'on ne touche pas
git tag -f v1 v1.0.0
git push --force origin v1
```

`v1.0.x` en tag **annoté** : il porte un auteur, une date et un message, et c'est ce qui
fait la différence entre une version relue et un déplacement de pointeur. `v1` en tag
**léger**, parce qu'il n'est qu'un pointeur et qu'il sera déplacé. Ne jamais réécrire un
`v1.x.y` : un consommateur peut en avoir mis le SHA en cache.

## Vérification

- `git tag` montre `v1` et `v1.0.0` pointant le même commit.
- Un dépôt de test consommant `@v1` fonctionne, et un autre consommant `@v1.0.0` aussi.

**Ce bloc s'attribuait une couverture inexistante.** Il renvoyait au « job 5 de la CI,
avec un SHA plutôt qu'un tag ». Mesuré : aucun des quatre jobs ne consomme un tag, un
SHA, ni aucune référence distante — les deux jobs de smoke montent `./` et
`./copie-action`, des chemins locaux. C'est une conséquence directe du lot 5 : une
expression étant interdite dans un `uses:`, la référence distante a été remplacée par un
checkout en sous-répertoire, qui prouve l'inégalité `GITHUB_ACTION_PATH ≠
GITHUB_WORKSPACE` mais **rien** sur la résolution d'un tag.

Donc : consommer `@v1` n'est vérifié par rien dans ce dépôt, et ne peut l'être que depuis
un **autre** dépôt. Ces deux lignes de vérification sont du travail réel, pas une
formalité de relecture.
