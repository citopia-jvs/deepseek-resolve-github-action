# Essai : Claude Code branché sur un modèle Scaleway

Mesures de la refonte « Claude Code + Scaleway » : peut-on remplacer aider + DeepSeek par
Claude Code, en le faisant parler à un modèle Scaleway à travers `scripts/proxy.js` ?
Ce fichier consigne ce qui a été **mesuré**, et sépare ce qui ne l'a pas été.

## Lot B — essai local (2026-11-06)

### Montage

- Poste : macOS 26.6.2 arm64, Node `v24.22.2`, Claude Code `2.1.311`.
- Proxy : `node scripts/proxy.js`, `PROXY_PORT=0`, clé amont lue depuis un fichier hors
  dépôt (`SCW_CLE_FICHIER`), jeton client aléatoire de 24 octets.
- `SCW_BASE_URL` : l'URL **propre au projet** Scaleway, de la forme
  `https://api.scaleway.ai/<id-projet>/v1`. Le défaut du proxy,
  `https://api.scaleway.ai/v1`, n'a pas été essayé.
- Dépôt jetable : une fonction `moyenne()` avec deux bugs (borne de boucle `<=`, tableau
  vide qui rend `NaN`) et deux tests `node --test`, `npm test` rouge au départ.
- Claude Code lancé sous `env -i`, avec un `CLAUDE_CONFIG_DIR` vide : ni réglages, ni
  hooks, ni `CLAUDE.md` de l'utilisateur, ni variable de la session appelante — l'état
  d'un runner.

```bash
claude -p "La commande npm test échoue dans ce dépôt. Trouve la cause, corrige le code \
(pas les tests), puis relance npm test pour vérifier qu'il passe." \
  --allowedTools "Read Edit Write Bash(npm test)" --max-turns 20 --output-format json
```

Variables passées à Claude Code : `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` (le jeton du
proxy), `ANTHROPIC_MODEL` et `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` (tous au modèle
essayé), `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`. Pour `glm-5.3` en plus :
`CLAUDE_CODE_MAX_CONTEXT_TOKENS=256000`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS=16384`.

### Résultats

| Modèle | `npm test` après | Tours | Durée | Tokens entrée / sortie | Requêtes au modèle |
| --- | --- | --- | --- | --- | --- |
| `qwen3.5-397b-a17b` | vert | 7 | 26 s | 110 982 / 1 014 | 5, toutes `200` |
| `qwen3.6-35b-a3b` | vert | 7 | 12 s | 113 187 / 1 170 | 5, toutes `200` |
| `glm-5.3` | vert | 8 | 10 s | 129 879 / 1 182 | 6, toutes `200` |

Les trois modèles ont produit le **même** diff, juste et minimal : `<` au lieu de `<=`, et
`if (nombres.length === 0) return 0;`. Aucun test touché, aucun refus de permission.

**Modèle retenu : `glm-5.3`**, fenêtre de contexte de 256K (valeur donnée par
l'utilisateur ; l'API `/models` de Scaleway ne la publie pas, elle ne rend que `id`,
`object`, `created` et `owned_by`).

### Ce que l'essai établit

- **Le proxy traduit correctement, en streaming**, un dialogue complet avec appels
  d'outils (`Read`, `Edit`, `Bash(npm test)`) : aucune réponse en erreur sur les trois
  modèles.
- **Changer de modèle ne demande que des variables** : `SCW_MODELE` côté proxy, les
  `ANTHROPIC_*_MODEL` côté Claude Code. Le proxy impose son `SCW_MODELE`, il faut donc le
  relancer pour en changer.
- **La fenêtre d'un modèle inconnu se règle par `CLAUDE_CODE_MAX_CONTEXT_TOKENS`**, pas
  par `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. Sans elle, Claude Code suppose 200 000 tokens.
  La documentation (`model-config`, « Correct the window for a gateway or custom model
  ID ») l'applique directement à un identifiant qui ne commence pas par `claude-` et ne
  porte pas `[1m]` ; mesuré : `contextWindow` rapporté à `256000`.
- **Le coût est dominé par le prompt système de Claude Code** : environ 21 000 tokens
  d'entrée par requête, sans aucun cache (`cache_read_input_tokens` à 0 sur tous les
  essais). Une correction de deux lignes coûte ainsi 110 000 à 130 000 tokens d'entrée.
- Une ligne sur stderr à chaque lancement, sans effet sur le résultat :
  `[claude-code:unrecognized_model] {"model":"glm-5.3","query_source":"sdk"}`. La
  documentation indique qu'une entrée `modelOverrides` la ferait taire.

### Ce que l'essai n'établit pas

- **`CLAUDE_CODE_MAX_OUTPUT_TOKENS=16384` n'est pas vérifié** : Claude Code rapporte
  toujours `maxOutputTokens: 32000`. Le journal du proxy n'enregistre pas le `max_tokens`
  reçu, la valeur réellement demandée n'est donc pas connue. Sans conséquence pratique :
  le proxy borne `max_tokens` à `PLAFOND_MAX_TOKENS` (16 384) de toute façon.
- La sortie maximale de `glm-5.3` n'est pas connue.
- Le plafond `PLAFOND_MAX_TOKENS` n'a jamais été atteint : aucune réponse n'a dépassé
  460 tokens.
- La compaction automatique n'a jamais été déclenchée : la plus grosse requête faisait
  23 379 tokens.
- Le coût en euros : le `costUSD` que rapporte Claude Code est calculé sur une base
  inconnue (`costBasis: "unknown"`) et ne correspond pas au tarif Scaleway.
- Tout ce qui relève du runner (grille go / no-go du lot C) : survie du proxy entre
  steps, refus d'un Bash hors liste blanche, écriture sous `.github/workflows/`,
  injection dans l'issue.
